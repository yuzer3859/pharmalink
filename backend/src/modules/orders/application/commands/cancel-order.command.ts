import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  COUPON_PORT,
  ICouponPort,
} from '../../../payment/application/ports/inbound/coupon.port';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { OrdersErrors } from '../../domain/errors';
import { OrderStatus } from '../../domain/enums';
import { orderCancelledEvent } from '../../domain/events';
import {
  IOrderRepository,
  ORDER_REPOSITORY,
  OrderSnapshot,
} from '../../domain/repositories/order.repository';
import { CancellationPolicy } from '../../domain/services/cancellation-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithOrderRetry } from '../support/order-retry';

export interface CancelOrderInput {
  orderId: string;
  customerUserId: string;
  reason: string;
}

/**
 * `POST /orders/:id/cancel` (module-06 `06-orders-spec.md` §9.3, §3.5, §8, BR-ORD-08). Ownership
 * is enforced identically to `GetOrderQuery` (§7, no existence leakage — `ORDER_NOT_FOUND` covers
 * both "doesn't exist" and "belongs to another customer"). `CancellationPolicy` is the sole
 * authority on *whether* cancellation is allowed for the order's current status (§3.5);
 * `OrderStatusPolicy` then validates the resulting `-> CANCELLED` transition itself is legal
 * (§3.11 invariant 3) — the two policies are deliberately kept separate, per their own doc
 * comments.
 *
 * Reservation release (§3.11 invariant 5) happens via `IInventoryPort.release()` for every
 * `OrderLine.reservationId` on the order, called *before* this command's own `Serializable`
 * transaction — mirroring `RematchCommand`'s "release the declined holds first" ordering
 * (ADR-014): Module 04 owns its own release transaction, and a release failure does not block the
 * order from being cancelled (Module 04's reservation TTL sweeper self-heals any stragglers, same
 * accepted eventual-consistency seam ADR-014/ADR-007 already formalize elsewhere in this spec).
 *
 * Single `Serializable` transaction (§11): re-read the order fresh inside the transaction (never
 * the pre-transaction read, §11's concurrent-cancel-vs-accept race discipline), re-validate both
 * policies, persist the `CANCELLED` status + `OrderStatusHistory` row, audit entry, outbox
 * `OrderCancelled` (§8).
 */
@Injectable()
export class CancelOrderCommand {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(COUPON_PORT) private readonly coupons: ICouponPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: CancelOrderInput): Promise<OrderSnapshot> {
    const order = await this.orders.findById(input.orderId);
    if (!order || order.customerUserId !== input.customerUserId) {
      throw OrdersErrors.orderNotFound();
    }
    CancellationPolicy.assertCanCancel(order.status);
    OrderStatusPolicy.assertValidTransition(order.status, OrderStatus.CANCELLED);

    const lines = await this.orders.findLinesByOrderId(order.id);
    const reservationIds = [...new Set(lines.map((line) => line.reservationId).filter(
      (id): id is string => id !== null,
    ))];
    await Promise.allSettled(
      reservationIds.map((reservationId) =>
        this.inventory.release({ reservationId, reason: 'customer-cancel' }),
      ),
    );

    // Coupon reversal (F-CPN-03), alongside the reservation release and for the same reasons:
    // Module 07 owns its own transaction (ADR-014), so this cannot join the one below, and a
    // failure must not block a cancellation the customer is entitled to.
    //
    // `reverse` only ever touches a redemption that is actually `APPLIED` — it is a no-op replay
    // for one already `REVERSED`, and raises nothing to swallow when the order carries no coupon
    // at all. Flipping it back frees the usage purely because the limits count `APPLIED` rows, so
    // the customer can spend the code again.
    //
    // It moves **no money**, deliberately. A cancelled order's *money* is Module 07's refund flow
    // against the payment (§11.4), driven by ADR-017's eligibility rules — not by this command and
    // not by a coupon reversal. A reversal that also moved money would double-count every
    // cancellation. Slice 1 is COD, so no payment has been captured here at all.
    await this.reverseCouponBestEffort(order.id, input.customerUserId);

    return runWithOrderRetry(this.uow, async (tx) => {
      const fresh = await this.orders.findById(order.id, tx);
      if (!fresh || fresh.customerUserId !== input.customerUserId) {
        throw OrdersErrors.orderNotFound();
      }
      CancellationPolicy.assertCanCancel(fresh.status);
      OrderStatusPolicy.assertValidTransition(fresh.status, OrderStatus.CANCELLED);

      await this.orders.updateStatus(
        fresh.id,
        {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: input.reason,
        },
        {
          fromStatus: fresh.status,
          toStatus: OrderStatus.CANCELLED,
          event: 'ORDER_CANCELLED',
          actorUserId: input.customerUserId,
          actorRole: 'CUSTOMER',
          reason: input.reason,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'ORDER_CANCELLED',
          resourceType: 'Order',
          resourceId: fresh.id,
          context: { reason: input.reason },
        },
        tx,
      );

      await this.outbox.write(
        orderCancelledEvent({ orderId: fresh.id, reason: input.reason }),
        tx as never,
      );

      return (await this.orders.findById(fresh.id, tx)) as OrderSnapshot;
    });
  }

  /**
   * Gives the coupon's usage back, if this order had one.
   *
   * Best-effort in exactly the sense the reservation release above is (ADR-014): Module 07 commits
   * it in its own transaction, and a failure here must not prevent a cancellation the customer is
   * entitled to. The asymmetry with stock is worth naming — Module 04's TTL sweeper self-heals a
   * stranded reservation, while a stranded `APPLIED` redemption has no sweeper, so the cost of a
   * failure is one usage the customer cannot immediately re-spend. That is strictly better than
   * refusing to cancel their order over it, and it is recoverable by an operator through the
   * redemption record.
   *
   * `ICouponPort.reverse` is idempotent, so a retried cancellation is safe.
   */
  private async reverseCouponBestEffort(orderId: string, actorUserId: string): Promise<void> {
    try {
      await this.coupons.reverse({
        orderId,
        // No code and no redemption id: Module 07 finds this order's own `APPLIED` redemption. A
        // caller-supplied code here would let a request aim a reversal at a different coupon.
        actorUserId,
        reason: 'order-cancelled',
      });
    } catch {
      // Includes the ordinary "this order has no coupon" case, which is not an error worth
      // distinguishing — there is nothing to reverse either way.
    }
  }
}
