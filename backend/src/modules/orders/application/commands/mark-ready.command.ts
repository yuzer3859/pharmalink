import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IInventoryPort,
  INVENTORY_PORT,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { OrdersErrors } from '../../domain/errors';
import { FulfillmentStatus, OrderStatus } from '../../domain/enums';
import { orderReadyEvent } from '../../domain/events';
import {
  FulfillmentSnapshot,
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';
import { runWithOrderRetry } from '../support/order-retry';

export interface MarkReadyInput {
  fulfillmentId: string;
  actorUserId: string;
}

/**
 * `POST /pharmacy/orders/:fulfillmentId/ready` (module-06 `06-orders-spec.md` §9.4, §3.4, §3.6,
 * §3.11 invariant 4, BR-ORD-10). Org-scoped identically to `AcceptFulfillmentCommand` (Step 6).
 *
 * §3.11 invariant 4: dispatches stock via `IInventoryPort.dispatch()` for every `OrderLine` on
 * this fulfillment that holds a reservation, *before* this command's own local transaction
 * (Module 04 owns its own dispatch transaction, ADR-014's accepted eventual-consistency seam,
 * mirroring `PrepareFulfillmentCommand`'s own dispensing-before-local-transaction ordering).
 *
 * Slice 1 has exactly one `Fulfillment` per `Order` (§3.6), so `Fulfillment.status -> READY`
 * always cascades `Order.status: ACCEPTED -> READY` in the same step (§3.4's transition table,
 * §3.11 invariant 4's "cascades only once every fulfillment... reaches READY" — trivially true
 * with exactly one). Both state machines are asserted independently, never collapsed into one.
 *
 * Single `Serializable` transaction (§11): re-read both fresh inside the transaction, re-validate
 * both transitions, persist `Fulfillment.status -> READY` + `Order.status -> READY` (+
 * `OrderStatusHistory` row), audit entry, outbox `OrderReady` (§8).
 */
@Injectable()
export class MarkReadyCommand {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: MarkReadyInput): Promise<FulfillmentSnapshot> {
    const fulfillment = await this.fulfillments.findById(input.fulfillmentId);
    if (!fulfillment) {
      throw OrdersErrors.notFound('Fulfillment not found.');
    }
    await assertFulfillmentOrgScope(
      this.identity,
      this.pharmacies,
      input.actorUserId,
      fulfillment.pharmacyId,
    );

    const order = await this.orders.findById(fulfillment.orderId);
    if (!order) {
      throw OrdersErrors.orderNotFound();
    }

    FulfillmentStatusPolicy.assertValidTransition(fulfillment.status, FulfillmentStatus.READY);
    OrderStatusPolicy.assertValidTransition(order.status, OrderStatus.READY);

    const lines = await this.orders.findLinesByOrderId(fulfillment.orderId);
    const reservationIds = [
      ...new Set(
        lines
          .filter((line) => line.fulfillmentId === fulfillment.id)
          .map((line) => line.reservationId)
          .filter((id): id is string => id !== null),
      ),
    ];
    for (const reservationId of reservationIds) {
      await this.inventory.dispatch({ reservationId, actorUserId: input.actorUserId });
    }

    return runWithOrderRetry(this.uow, async (tx) => {
      const freshFulfillment = await this.fulfillments.findById(fulfillment.id, tx);
      const freshOrder = await this.orders.findById(order.id, tx);
      if (!freshFulfillment || !freshOrder) {
        throw OrdersErrors.notFound('Fulfillment not found.');
      }
      FulfillmentStatusPolicy.assertValidTransition(freshFulfillment.status, FulfillmentStatus.READY);
      OrderStatusPolicy.assertValidTransition(freshOrder.status, OrderStatus.READY);

      await this.fulfillments.updateStatus(
        freshFulfillment.id,
        { status: FulfillmentStatus.READY, readyAt: new Date() },
        tx,
      );
      await this.orders.updateStatus(
        freshOrder.id,
        { status: OrderStatus.READY },
        {
          fromStatus: freshOrder.status,
          toStatus: OrderStatus.READY,
          event: 'ORDER_READY',
          actorUserId: input.actorUserId,
          actorRole: 'PHARMACY',
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'ORDER_READY',
          resourceType: 'Order',
          resourceId: freshOrder.id,
          context: { fulfillmentId: freshFulfillment.id },
        },
        tx,
      );

      await this.outbox.write(
        orderReadyEvent({ orderId: freshOrder.id, fulfillmentId: freshFulfillment.id }),
        tx as never,
      );

      return (await this.fulfillments.findById(freshFulfillment.id, tx)) as FulfillmentSnapshot;
    });
  }
}
