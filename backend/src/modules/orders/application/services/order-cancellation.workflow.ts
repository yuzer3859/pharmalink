import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { COUPON_PORT, ICouponPort } from '../../../payment/application/ports/inbound/coupon.port';
import { IInventoryPort, INVENTORY_PORT } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { OrderStatus } from '../../domain/enums';
import { OrdersErrors } from '../../domain/errors';
import { orderCancelledEvent } from '../../domain/events';
import {
  CancellationPhase,
  CancellationRequestSnapshot,
  IOrderCancellationRequestRepository,
  ORDER_CANCELLATION_REQUEST_REPOSITORY,
} from '../../domain/repositories/order-cancellation-request.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { CancellationPolicy } from '../../domain/services/cancellation-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { cancellationFailureCode, classifyCancellationFailure } from '../support/cancellation-failure';
import { runWithOrderRetry } from '../support/order-retry';

/** How long one executor may work a request before another may take it over. */
export const CANCELLATION_LEASE_MS = 2 * 60_000;
/** Attempts (transient failures) before a request is flagged for an operator. */
export const CANCELLATION_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** Who is driving this run — recorded in the audit context, never as the initiator. */
export type CancellationProcessor = 'REQUEST' | 'RECOVERY';

/**
 * Where a run left the request:
 *  - `COMPLETED`       — order cancelled and coupon reversed (or nothing to reverse);
 *  - `ORDER_CANCELLED` — order cancelled; the coupon step is pending (retry or attention);
 *  - `REJECTED`        — Module 04 refused: a reservation was already dispatched; nothing changed;
 *  - `PENDING`         — a transient failure; a retry is scheduled;
 *  - `ATTENTION`       — a permanent failure (or exhausted retries) before the order was cancelled;
 *  - `BUSY`            — another executor holds the request's lease (or took it over mid-run).
 */
export type CancellationOutcome = 'COMPLETED' | 'ORDER_CANCELLED' | 'REJECTED' | 'PENDING' | 'ATTENTION' | 'BUSY';

class LeaseLost extends Error {}

/**
 * Durable customer cancellation (Work 55) — one saga, persisted as `order_cancellation_requests`,
 * advanced by the request path and by `OrderCancellationReconciler` alike:
 *
 *     REQUESTED ──release (Module 04, all-or-nothing)──▶ STOCK_RELEASED
 *        │ dispatched                                       │ cancel the order (one Module 06 tx:
 *        ▼                                                  ▼ status + history + audit + outbox + phase)
 *     REJECTED                                         ORDER_CANCELLED ──reverse coupon (Module 07)──▶ COMPLETED
 *
 * Intent is persisted before the first Module 04 write. Each step is idempotent: the batch release is
 * a no-op for `RELEASED` reservations, so a crash before the `STOCK_RELEASED` marker just repeats it;
 * the order step re-reads the order inside its Serializable transaction and writes its phase there,
 * so it happens once; the coupon reversal by order id reverses the order's `APPLIED` redemption once
 * and answers `NOT_FOUND` thereafter (taken as done). Only the holder of the request's lease may move
 * it, and every phase write is a compare-and-set on (phase, lease) — no transaction is held across the
 * Module 04/07 calls. The original customer and reason stay the initiator; who processed it is audit
 * context. Failures are classified (`classifyCancellationFailure`): dispatch rejects, transient ones
 * back off, permanent ones (and exhausted retries) are flagged for an operator — never swallowed.
 */
@Injectable()
export class OrderCancellationWorkflow {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(ORDER_CANCELLATION_REQUEST_REPOSITORY) private readonly requests: IOrderCancellationRequestRepository,
    @Inject(INVENTORY_PORT) private readonly inventory: IInventoryPort,
    @Inject(COUPON_PORT) private readonly coupons: ICouponPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(OrderCancellationWorkflow.name);
  }

  /**
   * Request path: re-validate the order under a Serializable transaction and record the intent
   * (already leased to this run), or pick up the order's existing request; then drive it.
   */
  async start(input: { orderId: string; customerUserId: string; reason: string }): Promise<CancellationOutcome> {
    const owner = randomUUID();
    const now = new Date();
    let request: CancellationRequestSnapshot;
    let created: boolean;
    try {
      ({ request, created } = await runWithOrderRetry(this.uow, async (tx) => {
        const fresh = await this.orders.findById(input.orderId, tx);
        if (!fresh || fresh.customerUserId !== input.customerUserId) throw OrdersErrors.orderNotFound();
        CancellationPolicy.assertCanCancel(fresh.status);
        OrderStatusPolicy.assertValidTransition(fresh.status, OrderStatus.CANCELLED);
        // Read the order's lines here, in the transaction that records the intent: a pharmacy
        // decline's Phase 3a re-points these lines after reading this order's cancellation request,
        // so the two Serializable transactions conflict and one is retried — the release step below
        // then always sees the lines' current reservations (DeclineFulfillmentCommand, Work 55).
        await this.orders.findLinesByOrderId(input.orderId, tx);
        return this.requests.createOrGet(
          { ...input, leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + CANCELLATION_LEASE_MS) },
          tx,
        );
      }));
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'P2002') throw err;
      // A concurrent request recorded the intent first; continue with that row.
      const winner = await this.requests.findByOrderId(input.orderId);
      if (!winner) throw err;
      ({ request, created } = { request: winner, created: false });
    }
    if (!created) {
      if (request.phase === CancellationPhase.REJECTED) return 'REJECTED';
      if (request.phase === CancellationPhase.COMPLETED) return 'COMPLETED';
      const at = new Date();
      if (!(await this.requests.claim(request.id, owner, at, new Date(at.getTime() + CANCELLATION_LEASE_MS), true))) {
        // The claim refuses a terminal phase as well as a live lease: decide from the persisted row.
        return this.outcomeWithoutLease(request.id);
      }
      request = (await this.requests.findById(request.id)) as CancellationRequestSnapshot;
    }
    return this.drive(request, owner, 'REQUEST');
  }

  /** Reconciler path: take the lease (unless live or flagged) and drive the request. */
  async resume(requestId: string): Promise<CancellationOutcome> {
    const owner = randomUUID();
    const now = new Date();
    if (!(await this.requests.claim(requestId, owner, now, new Date(now.getTime() + CANCELLATION_LEASE_MS), false))) return 'BUSY';
    const request = await this.requests.findById(requestId);
    if (!request) return 'BUSY';
    return this.drive(request, owner, 'RECOVERY');
  }

  private async drive(request: CancellationRequestSnapshot, owner: string, by: CancellationProcessor): Promise<CancellationOutcome> {
    let phase = request.phase;
    try {
      for (;;) {
        if (phase === CancellationPhase.REQUESTED) {
          phase = await this.releaseStock(request, owner);
        } else if (phase === CancellationPhase.STOCK_RELEASED) {
          phase = await this.cancelOrder(request, owner, by);
        } else if (phase === CancellationPhase.ORDER_CANCELLED) {
          phase = await this.reverseCoupon(request, owner, by);
        } else {
          return phase === CancellationPhase.REJECTED ? 'REJECTED' : 'COMPLETED';
        }
      }
    } catch (err) {
      if (err instanceof LeaseLost) return this.outcomeWithoutLease(request.id);
      return this.fail(request, owner, phase, err, by);
    }
  }

  private async releaseStock(request: CancellationRequestSnapshot, owner: string): Promise<CancellationPhase> {
    const lines = await this.orders.findLinesByOrderId(request.orderId);
    const reservationIds = [...new Set(lines.map((l) => l.reservationId).filter((id): id is string => id !== null))];
    if (reservationIds.length > 0) {
      await this.inventory.releaseAllUnlessDispatched({ reservationIds, reason: 'customer-cancel' });
    }
    await this.move(request.id, owner, CancellationPhase.REQUESTED, CancellationPhase.STOCK_RELEASED);
    return CancellationPhase.STOCK_RELEASED;
  }

  private async cancelOrder(request: CancellationRequestSnapshot, owner: string, by: CancellationProcessor): Promise<CancellationPhase> {
    await runWithOrderRetry(this.uow, async (tx) => {
      const fresh = await this.orders.findById(request.orderId, tx);
      if (!fresh) throw OrdersErrors.orderNotFound();
      if (fresh.status !== OrderStatus.CANCELLED) {
        CancellationPolicy.assertCanCancel(fresh.status);
        OrderStatusPolicy.assertValidTransition(fresh.status, OrderStatus.CANCELLED);
        await this.orders.updateStatus(
          fresh.id,
          { status: OrderStatus.CANCELLED, cancelledAt: new Date(), cancelReason: request.reason },
          {
            fromStatus: fresh.status,
            toStatus: OrderStatus.CANCELLED,
            event: 'ORDER_CANCELLED',
            actorUserId: request.customerUserId,
            actorRole: 'CUSTOMER',
            reason: request.reason,
          },
          tx,
        );
        await this.audit.record(
          {
            actorUserId: request.customerUserId,
            action: 'ORDER_CANCELLED',
            resourceType: 'Order',
            resourceId: fresh.id,
            context: { reason: request.reason, cancellationRequestId: request.id, processedBy: by === 'REQUEST' ? 'CUSTOMER_REQUEST' : 'SYSTEM_RECOVERY' },
          },
          tx,
        );
        await this.outbox.write(orderCancelledEvent({ orderId: fresh.id, reason: request.reason }), tx as never);
      }
      // Same transaction: the order's cancellation and this phase commit (or roll back) together.
      if (!(await this.requests.advance(request.id, owner, CancellationPhase.STOCK_RELEASED, CancellationPhase.ORDER_CANCELLED, new Date(), tx))) {
        throw new LeaseLost();
      }
    });
    return CancellationPhase.ORDER_CANCELLED;
  }

  private async reverseCoupon(request: CancellationRequestSnapshot, owner: string, by: CancellationProcessor): Promise<CancellationPhase> {
    try {
      await this.coupons.reverse({
        orderId: request.orderId,
        actorUserId: request.customerUserId,
        reason: by === 'REQUEST' ? 'order-cancelled' : 'order-cancelled (recovered)',
      });
    } catch (err) {
      // By order id, Module 07 reverses the order's APPLIED redemption; once none is APPLIED —
      // never had a coupon, or already reversed by an earlier run — it answers NOT_FOUND: done.
      if (!(err instanceof ApiException && err.code === ErrorCode.NOT_FOUND)) throw err;
    }
    await this.move(request.id, owner, CancellationPhase.ORDER_CANCELLED, CancellationPhase.COMPLETED);
    return CancellationPhase.COMPLETED;
  }

  /**
   * This run does not (or no longer) hold the lease. The outcome comes from the PERSISTED phase,
   * never from this run's in-memory snapshot: another executor may already have finished it —
   * `REJECTED` (a dispatch won) or `COMPLETED` — or still be working on it (`BUSY`).
   */
  private async outcomeWithoutLease(id: string): Promise<CancellationOutcome> {
    const current = await this.requests.findById(id);
    if (current?.phase === CancellationPhase.REJECTED) return 'REJECTED';
    if (current?.phase === CancellationPhase.COMPLETED) return 'COMPLETED';
    return 'BUSY';
  }

  private async move(id: string, owner: string, from: CancellationPhase, to: CancellationPhase): Promise<void> {
    if (!(await this.requests.advance(id, owner, from, to, new Date()))) throw new LeaseLost();
  }

  private async fail(
    request: CancellationRequestSnapshot,
    owner: string,
    phase: CancellationPhase,
    err: unknown,
    by: CancellationProcessor,
  ): Promise<CancellationOutcome> {
    const kind = classifyCancellationFailure(err);
    const code = cancellationFailureCode(err);
    const orderCancelled = phase === CancellationPhase.ORDER_CANCELLED;
    const log = { requestId: request.id, orderId: request.orderId, phase, errorCode: code, processedBy: by };
    if (kind === 'DISPATCHED' && phase === CancellationPhase.REQUESTED) {
      const ok = await this.requests.advance(request.id, owner, CancellationPhase.REQUESTED, CancellationPhase.REJECTED, new Date(), undefined, 'RESERVATIONS_DISPATCHED');
      if (!ok) return this.outcomeWithoutLease(request.id);
      this.logger.warn({ message: 'Order cancellation rejected: stock already dispatched', ...log });
      return 'REJECTED';
    }
    const latest = await this.requests.findById(request.id);
    const attempts = (latest?.attempts ?? request.attempts) + 1;
    const now = new Date();
    if (kind === 'TRANSIENT' && attempts < CANCELLATION_MAX_ATTEMPTS) {
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
      await this.requests.scheduleRetry(request.id, owner, now, new Date(now.getTime() + delay), code);
      this.logger.warn({ message: 'Order cancellation step failed; retry scheduled', ...log, attempts, retryInMs: delay });
      return orderCancelled ? 'ORDER_CANCELLED' : 'PENDING';
    }
    await this.requests.requireAttention(request.id, owner, now, code);
    this.logger.error({ message: 'Order cancellation needs operator attention', ...log, attempts, kind });
    return orderCancelled ? 'ORDER_CANCELLED' : 'ATTENTION';
  }
}
