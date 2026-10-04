import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { MatchStatus } from '../../../prescription-matching/domain/enums';
import {
  IMatchingPort,
  MATCHING_PORT,
} from '../../../prescription-matching/application/ports/inbound/matching.port';
import { OrdersErrors } from '../../domain/errors';
import { FulfillmentStatus, OrderStatus } from '../../domain/enums';
import { orderCancelledEvent } from '../../domain/events';
import {
  FulfillmentSnapshot,
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { CancellationPolicy } from '../../domain/services/cancellation-policy';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';
import { runWithOrderRetry } from '../support/order-retry';

export interface DeclineFulfillmentInput {
  fulfillmentId: string;
  actorUserId: string;
  reason: string;
}

export interface DeclineFulfillmentResult {
  declinedFulfillment: FulfillmentSnapshot;
  /** Present only when the re-match found a new pharmacy (BR-ORD-14) — absent when the order was
   * cancelled instead (BRULE-19). */
  newFulfillment: FulfillmentSnapshot | null;
  /** `true` when re-match exhausted every candidate and the order was cancelled (BRULE-19). */
  orderCancelled: boolean;
}

/**
 * `POST /pharmacy/orders/:fulfillmentId/decline` (module-06 `06-orders-spec.md` §9.4, §3.4, §3.6,
 * BR-ORD-10/BR-ORD-14, BRULE-19). Org-scoped identically to `AcceptFulfillmentCommand` (Step 6).
 *
 * Three phases, matching §4's "Module 06 calls Module 05's already-atomic sequence as one step"
 * discipline (ADR-014) — each cross-module call opens its own transaction; this command never
 * attempts to span them into one distributed transaction:
 *
 *  1. **Local** (`Serializable`, own transaction): `Fulfillment.status -> CANCELLED` for the
 *     declined fulfillment, audited. `Order.status` is untouched here — BRULE-19's "stays PAID,
 *     no status change" applies to the re-match-pending window.
 *  2. **Cross-module** (Module 05's own transaction): `IMatchingPort.rematch()` on the order's
 *     `matchRequestId`, scoped to this fulfillment's own `OrderLine`s — Module 05 already
 *     releases the declined pharmacy's reservations and re-reserves the new one atomically
 *     (`RematchCommand`, ADR-014); this command does not duplicate that release/reserve logic.
 *  3. **Local** (`Serializable`, own transaction): branches on the re-match outcome —
 *     - `MATCHED`: create a new `Fulfillment` (`PENDING`) for the chosen pharmacy/branch and
 *       re-point every declined `OrderLine` at it (`IOrderRepository.updateLineFulfillment()`,
 *       matched by `catalogProductId`) — no outbox event (module-05's own `RematchTriggered`
 *       already covers the re-match signal, §8's "Module 06 does not duplicate them").
 *     - otherwise (`FAILED`/no chosen result): `Order.status -> CANCELLED` (BRULE-19), audited,
 *       outbox `OrderCancelled` (§8).
 */
@Injectable()
export class DeclineFulfillmentCommand {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(MATCHING_PORT) private readonly matching: IMatchingPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DeclineFulfillmentInput): Promise<DeclineFulfillmentResult> {
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
    if (!order.matchRequestId) {
      throw OrdersErrors.validation('Order has no associated match request to re-match against.');
    }

    FulfillmentStatusPolicy.assertValidTransition(fulfillment.status, FulfillmentStatus.CANCELLED);

    const declinedLines = (await this.orders.findLinesByOrderId(fulfillment.orderId)).filter(
      (line) => line.fulfillmentId === fulfillment.id,
    );

    // Phase 1 — cancel the declined fulfillment (own local transaction).
    const declinedFulfillment = await runWithOrderRetry(this.uow, async (tx) => {
      const fresh = await this.fulfillments.findById(fulfillment.id, tx);
      if (!fresh) {
        throw OrdersErrors.notFound('Fulfillment not found.');
      }
      FulfillmentStatusPolicy.assertValidTransition(fresh.status, FulfillmentStatus.CANCELLED);
      await this.fulfillments.updateStatus(fresh.id, { status: FulfillmentStatus.CANCELLED }, tx);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'FULFILLMENT_DECLINED',
          resourceType: 'Fulfillment',
          resourceId: fresh.id,
          context: { orderId: fulfillment.orderId, reason: input.reason },
        },
        tx,
      );

      return (await this.fulfillments.findById(fresh.id, tx)) as FulfillmentSnapshot;
    });

    // Phase 2 — re-match via Module 05 (its own transaction, ADR-014).
    const rematchResult = await this.matching.rematch({
      matchRequestId: order.matchRequestId,
      customerUserId: order.customerUserId,
      lines: declinedLines.map((line) => ({
        catalogProductId: line.catalogProductId,
        quantity: line.quantity,
      })),
    });

    // Phase 3a — re-match succeeded: create the new fulfillment and re-point the order lines.
    if (rematchResult.status === MatchStatus.MATCHED && rematchResult.chosenResult) {
      const chosenResult = rematchResult.chosenResult;
      const newFulfillment = await runWithOrderRetry(this.uow, async (tx) => {
        const created = await this.fulfillments.create(
          {
            orderId: fulfillment.orderId,
            pharmacyId: chosenResult.pharmacyId,
            branchId: chosenResult.branchId,
          },
          tx,
        );

        for (const line of declinedLines) {
          const chosenLine = chosenResult.lines.find(
            (l) => l.catalogProductId === line.catalogProductId,
          );
          if (!chosenLine) {
            continue;
          }
          await this.orders.updateLineFulfillment(
            line.id,
            {
              fulfillmentId: created.id,
              pharmacyId: chosenResult.pharmacyId,
              branchId: chosenResult.branchId,
              reservationId: chosenLine.reservationId,
            },
            tx,
          );
        }

        await this.audit.record(
          {
            actorUserId: input.actorUserId,
            action: 'FULFILLMENT_REMATCHED',
            resourceType: 'Order',
            resourceId: fulfillment.orderId,
            context: {
              declinedFulfillmentId: fulfillment.id,
              newFulfillmentId: created.id,
              pharmacyId: chosenResult.pharmacyId,
            },
          },
          tx,
        );

        return created;
      });

      return { declinedFulfillment, newFulfillment, orderCancelled: false };
    }

    // Phase 3b — re-match exhausted every candidate: cancel the order (BRULE-19).
    await runWithOrderRetry(this.uow, async (tx) => {
      const freshOrder = await this.orders.findById(order.id, tx);
      if (!freshOrder) {
        throw OrdersErrors.orderNotFound();
      }
      CancellationPolicy.assertCanCancel(freshOrder.status);
      OrderStatusPolicy.assertValidTransition(freshOrder.status, OrderStatus.CANCELLED);

      await this.orders.updateStatus(
        freshOrder.id,
        {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: 'NO_PHARMACY_MATCH',
        },
        {
          fromStatus: freshOrder.status,
          toStatus: OrderStatus.CANCELLED,
          event: 'ORDER_CANCELLED',
          actorUserId: input.actorUserId,
          actorRole: 'PHARMACY',
          reason: 'NO_PHARMACY_MATCH',
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'ORDER_CANCELLED',
          resourceType: 'Order',
          resourceId: freshOrder.id,
          context: { reason: 'NO_PHARMACY_MATCH', declinedFulfillmentId: fulfillment.id },
        },
        tx,
      );

      await this.outbox.write(
        orderCancelledEvent({ orderId: freshOrder.id, reason: 'NO_PHARMACY_MATCH' }),
        tx as never,
      );
    });

    return { declinedFulfillment, newFulfillment: null, orderCancelled: true };
  }
}
