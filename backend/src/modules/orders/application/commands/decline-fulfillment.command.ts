import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { MatchStatus } from '../../../prescription-matching/domain/enums';
import {
  IMatchingPort,
  MATCHING_PORT,
} from '../../../prescription-matching/application/ports/inbound/matching.port';
import { IInventoryPort, INVENTORY_PORT } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { OrdersErrors } from '../../domain/errors';
import { FulfillmentStatus, OrderStatus } from '../../domain/enums';
import { orderCancelledEvent } from '../../domain/events';
import {
  FulfillmentSnapshot,
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import {
  CancellationPhase,
  IOrderCancellationRequestRepository,
  ORDER_CANCELLATION_REQUEST_REPOSITORY,
} from '../../domain/repositories/order-cancellation-request.repository';
import { CancellationPolicy } from '../../domain/services/cancellation-policy';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';
import { classifyCancellationFailure } from '../support/cancellation-failure';
import { runWithOrderRetry } from '../support/order-retry';

/** Immediate attempts per replacement confirmation when Module 04 fails transiently. */
const CONFIRM_ATTEMPTS = 3;

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
 *       Work 55: only while the order is still live — re-read in this transaction, it must be
 *       cancellable and carry no (non-rejected) customer cancellation request. That request read,
 *       against `OrderCancellationWorkflow.start` reading these order lines, makes the two
 *       Serializable transactions conflict, so one of them is retried: a cancellation either sees
 *       the replacement reservations on the lines (and releases them) or is seen here (and nothing
 *       is re-pointed). Refused, the replacement holds are released.
 *  4. **Cross-module** (Work 55), after 3a commits: `IInventoryPort.confirm()` each replacement
 *     reservation now on an order line, `HELD -> CONFIRMED` — as checkout confirms its own — so
 *     the TTL sweeper cannot expire the stock the order now relies on. Confirmed only once the
 *     order references it, so no CONFIRMED reservation is ever left unreferenced (CONFIRMED is
 *     never swept). A reservation a concurrent cancellation already released is not an error.
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
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(ORDER_CANCELLATION_REQUEST_REPOSITORY) private readonly cancellations: IOrderCancellationRequestRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(DeclineFulfillmentCommand.name);
  }

  private readonly logger = new AppLogger();

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
      const phase3 = await runWithOrderRetry(this.uow, async (tx) => {
        // Work 55: re-point only a still-live order (see the class doc for the conflict with a
        // concurrent customer cancellation).
        const liveOrder = await this.orders.findById(fulfillment.orderId, tx);
        if (!liveOrder || !CancellationPolicy.canCancel(liveOrder.status)) {
          return null;
        }
        const cancellation = await this.cancellations.findByOrderId(fulfillment.orderId, tx);
        if (cancellation && cancellation.phase !== CancellationPhase.REJECTED) {
          return null;
        }
        const repointed: string[] = [];
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
          repointed.push(chosenLine.reservationId);
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

        return { created, repointed };
      });

      const replacementIds = [...new Set(chosenResult.lines.map((l) => l.reservationId))];
      if (!phase3) {
        // The order was cancelled (or a customer cancellation is under way): nothing was re-pointed.
        // Its replacement holds are released; they are HELD, so the TTL sweeper is the backstop.
        await this.releaseReplacements(fulfillment.orderId, replacementIds);
        return { declinedFulfillment, newFulfillment: null, orderCancelled: true };
      }

      // Phase 4 — confirm exactly the replacement reservations the order now references.
      await this.confirmReplacements(fulfillment.orderId, [...new Set(phase3.repointed)]);
      return { declinedFulfillment, newFulfillment: phase3.created, orderCancelled: false };
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

  /**
   * Phase 4 (Work 55): `HELD -> CONFIRMED` for each replacement reservation on the order's lines,
   * through Module 04's own confirm (its reservation → listing lock order; a lapsed hold is expired
   * there, never confirmed). Transient failures are retried a few times; a reservation that a
   * concurrent customer cancellation has already released (the order is now cancelled) is not an
   * error. Anything else is surfaced, never swallowed.
   */
  private async confirmReplacements(orderId: string, reservationIds: string[]): Promise<void> {
    for (const reservationId of reservationIds) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await this.inventory.confirm({ reservationId });
          break;
        } catch (err) {
          if (err instanceof ApiException && err.code === ErrorCode.INVALID_RESERVATION_STATE) {
            const order = await this.orders.findById(orderId);
            if (order?.status === OrderStatus.CANCELLED) return; // released by the cancellation
          }
          if (classifyCancellationFailure(err) === 'TRANSIENT' && attempt < CONFIRM_ATTEMPTS) continue;
          this.logger.error({
            message: 'Replacement reservation could not be confirmed after a pharmacy decline',
            orderId,
            reservationId,
            errorCode: err instanceof ApiException ? err.code : 'UNKNOWN',
          });
          throw err;
        }
      }
    }
  }

  /** Releases the replacement holds of a decline whose order was cancelled meanwhile (they are HELD). */
  private async releaseReplacements(orderId: string, reservationIds: string[]): Promise<void> {
    if (reservationIds.length === 0) return;
    try {
      await this.inventory.releaseAllUnlessDispatched({ reservationIds, reason: 'decline-order-cancelled' });
    } catch (err) {
      this.logger.warn({
        message: 'Replacement holds of a decline on a cancelled order were not released; the TTL sweeper will expire them',
        orderId,
        errorCode: err instanceof ApiException ? err.code : 'UNKNOWN',
      });
    }
  }
}
