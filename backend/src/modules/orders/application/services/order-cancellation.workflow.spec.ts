import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { ICouponPort } from '../../../payment/application/ports/inbound/coupon.port';
import {
  CancellationPhase,
  CancellationRequestSnapshot,
  IOrderCancellationRequestRepository,
  OPEN_CANCELLATION_PHASES,
} from '../../domain/repositories/order-cancellation-request.repository';
import { IOrderRepository, OrderSnapshot } from '../../domain/repositories/order.repository';
import { orderLineSnapshot, orderSnapshot } from '../commands/test-fixtures';
import { classifyCancellationFailure, cancellationFailureCode } from '../support/cancellation-failure';
import { CANCELLATION_LEASE_MS, CANCELLATION_MAX_ATTEMPTS, OrderCancellationWorkflow } from './order-cancellation.workflow';

/** In-memory twin of the Prisma repository: the same (phase, lease) compare-and-set rules. */
class FakeRequests implements IOrderCancellationRequestRepository {
  rows = new Map<string, CancellationRequestSnapshot>();
  private seq = 0;
  private open = (r: CancellationRequestSnapshot) => (OPEN_CANCELLATION_PHASES as string[]).includes(r.phase);

  async createOrGet(input: { orderId: string; customerUserId: string; reason: string; leaseOwner: string; leaseExpiresAt: Date }) {
    const existing = [...this.rows.values()].find((r) => r.orderId === input.orderId);
    if (existing) return { request: { ...existing }, created: false };
    const now = new Date();
    const row: CancellationRequestSnapshot = {
      id: `req-${++this.seq}`, orderId: input.orderId, customerUserId: input.customerUserId, reason: input.reason,
      phase: CancellationPhase.REQUESTED, attempts: 0, nextAttemptAt: now, lastErrorCode: null, lastErrorAt: null,
      attentionRequiredAt: null, leaseOwner: input.leaseOwner, leaseExpiresAt: input.leaseExpiresAt, createdAt: now, updatedAt: now, completedAt: null,
    };
    this.rows.set(row.id, row);
    return { request: { ...row }, created: true };
  }
  async findByOrderId(orderId: string) { const r = [...this.rows.values()].find((x) => x.orderId === orderId); return r ? { ...r } : null; }
  async findById(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async claim(id: string, owner: string, now: Date, until: Date, ignoreAttention: boolean) {
    const r = this.rows.get(id);
    if (!r || !this.open(r) || (!ignoreAttention && r.attentionRequiredAt)) return false;
    if (r.leaseOwner && r.leaseOwner !== owner && r.leaseExpiresAt && r.leaseExpiresAt >= now) return false;
    Object.assign(r, { leaseOwner: owner, leaseExpiresAt: until });
    return true;
  }
  async advance(id: string, owner: string, from: CancellationPhase, to: CancellationPhase, now: Date, _tx?: unknown, code: string | null = null) {
    const r = this.rows.get(id);
    if (!r || r.phase !== from || r.leaseOwner !== owner) return false;
    const terminal = to === CancellationPhase.COMPLETED || to === CancellationPhase.REJECTED;
    Object.assign(r, { phase: to, attentionRequiredAt: null, lastErrorCode: code, lastErrorAt: code ? now : null },
      terminal ? { leaseOwner: null, leaseExpiresAt: null, completedAt: now } : {});
    return true;
  }
  async scheduleRetry(id: string, owner: string, now: Date, next: Date, code: string) {
    const r = this.rows.get(id);
    if (!r || r.leaseOwner !== owner || !this.open(r)) return false;
    Object.assign(r, { attempts: r.attempts + 1, nextAttemptAt: next, lastErrorCode: code, lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null });
    return true;
  }
  async requireAttention(id: string, owner: string, now: Date, code: string) {
    const r = this.rows.get(id);
    if (!r || r.leaseOwner !== owner || !this.open(r)) return false;
    Object.assign(r, { attempts: r.attempts + 1, attentionRequiredAt: now, lastErrorCode: code, lastErrorAt: now, leaseOwner: null, leaseExpiresAt: null });
    return true;
  }
  async releaseLease(id: string, owner: string) { const r = this.rows.get(id); if (r?.leaseOwner === owner) Object.assign(r, { leaseOwner: null, leaseExpiresAt: null }); }
  async listDue() { return []; }
}

function build(status = 'ACCEPTED') {
  let current: OrderSnapshot = orderSnapshot({ status: status as OrderSnapshot['status'] });
  const calls: string[] = [];
  const orders = {
    findById: jest.fn(async () => ({ ...current })),
    findLinesByOrderId: jest.fn(async () => [
      orderLineSnapshot({ id: 'l1', reservationId: 'reservation-2' }),
      orderLineSnapshot({ id: 'l2', reservationId: 'reservation-1' }),
      orderLineSnapshot({ id: 'l3', reservationId: 'reservation-2' }),
    ]),
    updateStatus: jest.fn(async (_id: string, update: { status: string }) => {
      calls.push('order:CANCELLED');
      current = { ...current, status: update.status as OrderSnapshot['status'] };
    }),
  } as unknown as jest.Mocked<IOrderRepository>;
  const requests = new FakeRequests();
  const inventory = { releaseAllUnlessDispatched: jest.fn(async () => { calls.push('release'); }) } as unknown as jest.Mocked<IInventoryPort>;
  const coupons = { reverse: jest.fn(async () => { calls.push('coupon'); return {}; }) } as unknown as jest.Mocked<ICouponPort>;
  const uow = { run: jest.fn((work: (tx: unknown) => Promise<unknown>) => work({ tx: true })) };
  const audit = { record: jest.fn(async () => ({ id: 'a', hash: 'h' })) };
  const outbox = { write: jest.fn(async () => undefined) };
  const workflow = new OrderCancellationWorkflow(orders, requests, inventory, coupons, uow as never, audit as never, outbox as never);
  return { workflow, orders, requests, inventory, coupons, audit, outbox, calls, setStatus: (s: string) => (current = { ...current, status: s as OrderSnapshot['status'] }) };
}

const start = (w: OrderCancellationWorkflow) => w.start({ orderId: 'order-1', customerUserId: 'customer-1', reason: 'Changed my mind' });
const only = (r: FakeRequests) => [...r.rows.values()][0];
const dispatched = () => new ApiException(ErrorCode.INVALID_RESERVATION_STATE, 'dispatched', { from: 'DISPATCHED', to: 'RELEASED', reservationIds: ['reservation-2'] });

describe('OrderCancellationWorkflow (Work 55)', () => {
  it('runs every phase in order: release (one de-duplicated batch) → order cancelled (one tx) → coupon reversed; lease ends', async () => {
    const t = build();
    expect(await start(t.workflow)).toBe('COMPLETED');
    expect(t.calls).toEqual(['release', 'order:CANCELLED', 'coupon']);
    expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledWith({ reservationIds: ['reservation-2', 'reservation-1'], reason: 'customer-cancel' });
    expect(only(t.requests)).toMatchObject({ phase: 'COMPLETED', leaseOwner: null, attentionRequiredAt: null, attempts: 0 });
    expect(only(t.requests).completedAt).toBeInstanceOf(Date);
    expect(t.audit.record).toHaveBeenCalledTimes(1);
    expect(t.outbox.write).toHaveBeenCalledTimes(1);
  });

  it('the original customer and reason are the initiator; the processor is audit context', async () => {
    const t = build();
    await start(t.workflow);
    expect(t.orders.updateStatus).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ status: 'CANCELLED', cancelReason: 'Changed my mind' }),
      expect.objectContaining({ actorUserId: 'customer-1', actorRole: 'CUSTOMER', reason: 'Changed my mind' }),
      { tx: true },
    );
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'customer-1', action: 'ORDER_CANCELLED', context: expect.objectContaining({ reason: 'Changed my mind', processedBy: 'CUSTOMER_REQUEST' }) }),
      { tx: true },
    );
    expect(t.coupons.reverse).toHaveBeenCalledWith({ orderId: 'order-1', actorUserId: 'customer-1', reason: 'order-cancelled' });
  });

  it('dispatched (Module 04 rejects the batch): REJECTED, terminal, nothing else touched', async () => {
    const t = build();
    t.inventory.releaseAllUnlessDispatched.mockRejectedValue(dispatched());
    expect(await start(t.workflow)).toBe('REJECTED');
    expect(only(t.requests)).toMatchObject({ phase: 'REJECTED', lastErrorCode: 'RESERVATIONS_DISPATCHED', leaseOwner: null });
    expect(t.orders.updateStatus).not.toHaveBeenCalled();
    expect(t.coupons.reverse).not.toHaveBeenCalled();
    // A later request for the same order reports it without redoing anything.
    expect(await start(t.workflow)).toBe('REJECTED');
    expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(1);
  });

  it('transient release failure: PENDING, REQUESTED kept, attempt counted, backoff scheduled, lease freed', async () => {
    const t = build();
    t.inventory.releaseAllUnlessDispatched.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'P1001' }));
    const before = Date.now();
    expect(await start(t.workflow)).toBe('PENDING');
    const r = only(t.requests);
    expect(r).toMatchObject({ phase: 'REQUESTED', attempts: 1, lastErrorCode: 'P1001', attentionRequiredAt: null, leaseOwner: null });
    expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(t.orders.updateStatus).not.toHaveBeenCalled();
    // Recovery repeats the (idempotent) release and finishes.
    r.nextAttemptAt = new Date(0);
    expect(await t.workflow.resume(r.id)).toBe('COMPLETED');
    expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(2);
  });

  it('permanent release failure (listing gone): ATTENTION before the order is cancelled; the reconciler leaves it alone', async () => {
    const t = build();
    t.inventory.releaseAllUnlessDispatched.mockRejectedValue(new ApiException(ErrorCode.LISTING_NOT_FOUND, 'Listing not found'));
    expect(await start(t.workflow)).toBe('ATTENTION');
    const r = only(t.requests);
    expect(r).toMatchObject({ phase: 'REQUESTED', lastErrorCode: 'LISTING_NOT_FOUND', leaseOwner: null });
    expect(r.attentionRequiredAt).toBeInstanceOf(Date);
    expect(t.orders.updateStatus).not.toHaveBeenCalled();
    expect(await t.workflow.resume(r.id)).toBe('BUSY'); // flagged: not claimable by the reconciler
  });

  it('transient failures stop retrying after the attempt budget and are flagged', async () => {
    const t = build();
    t.inventory.releaseAllUnlessDispatched.mockRejectedValue(new Error('flaky'));
    await start(t.workflow);
    const r = only(t.requests);
    r.attempts = CANCELLATION_MAX_ATTEMPTS - 1; // this failure is the last allowed attempt
    expect(await t.workflow.resume(r.id)).toBe('ATTENTION');
    expect(only(t.requests)).toMatchObject({ attempts: CANCELLATION_MAX_ATTEMPTS, lastErrorCode: 'UNKNOWN' });
  });

  it('order step failing (serialization retries exhausted → CONFLICT): stock stays released, PENDING at STOCK_RELEASED; recovery cancels once', async () => {
    const t = build();
    t.orders.updateStatus.mockRejectedValueOnce(new ApiException(ErrorCode.CONFLICT, 'changed concurrently'));
    expect(await start(t.workflow)).toBe('PENDING');
    const r = only(t.requests);
    expect(r).toMatchObject({ phase: 'STOCK_RELEASED', lastErrorCode: 'CONFLICT' });
    expect(await t.workflow.resume(r.id)).toBe('COMPLETED');
    expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(1); // not repeated past its marker
    expect(t.audit.record).toHaveBeenCalledTimes(1);
    expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'customer-1', context: expect.objectContaining({ processedBy: 'SYSTEM_RECOVERY' }) }), { tx: true });
    expect(t.coupons.reverse).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'customer-1', reason: 'order-cancelled (recovered)' }));
  });

  it('order already CANCELLED when the order step runs: no second history/audit/event — only the phase moves', async () => {
    const t = build();
    t.coupons.reverse.mockRejectedValueOnce(new Error('down'));
    t.inventory.releaseAllUnlessDispatched.mockImplementationOnce(async () => { t.setStatus('CANCELLED'); });
    expect(await start(t.workflow)).toBe('ORDER_CANCELLED');
    expect(t.orders.updateStatus).not.toHaveBeenCalled();
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(t.outbox.write).not.toHaveBeenCalled();
    expect(only(t.requests).phase).toBe('ORDER_CANCELLED');
  });

  it('coupon failure after the order is cancelled: outcome ORDER_CANCELLED (never "not cancelled"); retried later; NOT_FOUND counts as done', async () => {
    const t = build();
    t.coupons.reverse.mockRejectedValueOnce(new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'down'));
    expect(await start(t.workflow)).toBe('ORDER_CANCELLED');
    const r = only(t.requests);
    expect(r).toMatchObject({ phase: 'ORDER_CANCELLED', attempts: 1, lastErrorCode: 'DEPENDENCY_UNAVAILABLE' });
    t.coupons.reverse.mockRejectedValueOnce(new ApiException(ErrorCode.NOT_FOUND, 'No coupon redemption found for this order.'));
    expect(await t.workflow.resume(r.id)).toBe('COMPLETED');
    expect(t.orders.updateStatus).toHaveBeenCalledTimes(1);
  });

  it('a live lease held by another executor: BUSY, nothing called; an expired lease is taken over', async () => {
    const t = build();
    t.inventory.releaseAllUnlessDispatched.mockRejectedValueOnce(new Error('flaky'));
    await start(t.workflow);
    const r = only(t.requests);
    Object.assign(t.requests.rows.get(r.id)!, { leaseOwner: 'other', leaseExpiresAt: new Date(Date.now() + CANCELLATION_LEASE_MS) });
    expect(await t.workflow.resume(r.id)).toBe('BUSY');
    expect(await start(t.workflow)).toBe('BUSY');
    expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(1);
    t.requests.rows.get(r.id)!.leaseExpiresAt = new Date(Date.now() - 1);
    expect(await t.workflow.resume(r.id)).toBe('COMPLETED');
  });

  it('a lease lost mid-run: the stale executor stops (BUSY) without recording a retry or a phase', async () => {
    const t = build();
    t.inventory.releaseAllUnlessDispatched.mockImplementationOnce(async () => {
      Object.assign(only(t.requests), { leaseOwner: 'thief', leaseExpiresAt: new Date(Date.now() + 60_000) });
    });
    expect(await start(t.workflow)).toBe('BUSY');
    expect(only(t.requests)).toMatchObject({ phase: 'REQUESTED', attempts: 0, leaseOwner: 'thief' });
    expect(t.orders.updateStatus).not.toHaveBeenCalled();
  });

  describe('M1 — a lost claim or lease is decided from the persisted phase', () => {
    /** A request left open (REQUESTED, no lease) by an earlier run's transient failure. */
    async function openRequest() {
      const t = build();
      t.inventory.releaseAllUnlessDispatched.mockRejectedValueOnce(new Error('flaky'));
      expect(await start(t.workflow)).toBe('PENDING');
      return t;
    }

    it('REJECTED between createOrGet and claim: the outcome is REJECTED (→ 422), not BUSY (→ 503); nothing is processed', async () => {
      const t = await openRequest();
      const claim = jest.spyOn(t.requests, 'claim').mockImplementationOnce(async () => {
        // A concurrent executor rejects it just before this run's claim (which then refuses a terminal phase).
        Object.assign(only(t.requests), { phase: CancellationPhase.REJECTED, completedAt: new Date() });
        return false;
      });
      expect(await start(t.workflow)).toBe('REJECTED');
      expect(claim).toHaveBeenCalledTimes(1);
      expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(1); // only the earlier run
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
    });

    it('lease lost while recording a dispatched rejection: if the other executor persisted REJECTED, the outcome is REJECTED', async () => {
      const t = build();
      t.inventory.releaseAllUnlessDispatched.mockImplementationOnce(async () => {
        // Taken over mid-call; the new holder hit the same dispatch and recorded REJECTED.
        Object.assign(only(t.requests), { phase: CancellationPhase.REJECTED, leaseOwner: null, leaseExpiresAt: null, lastErrorCode: 'RESERVATIONS_DISPATCHED' });
        throw dispatched();
      });
      expect(await start(t.workflow)).toBe('REJECTED');
      expect(only(t.requests)).toMatchObject({ phase: 'REJECTED', attempts: 0 });
    });

    it('lease lost while recording a dispatched rejection, but the other executor still holds it open: BUSY (pending), no write', async () => {
      const t = build();
      t.inventory.releaseAllUnlessDispatched.mockImplementationOnce(async () => {
        Object.assign(only(t.requests), { leaseOwner: 'other', leaseExpiresAt: new Date(Date.now() + 60_000) });
        throw dispatched();
      });
      expect(await start(t.workflow)).toBe('BUSY');
      expect(only(t.requests)).toMatchObject({ phase: 'REQUESTED', leaseOwner: 'other', attempts: 0, lastErrorCode: null });
    });

    it('a genuinely active request owned by another executor stays BUSY (pending) and is not touched', async () => {
      const t = await openRequest();
      Object.assign(only(t.requests), { leaseOwner: 'other', leaseExpiresAt: new Date(Date.now() + 60_000) });
      expect(await start(t.workflow)).toBe('BUSY');
      expect(only(t.requests)).toMatchObject({ phase: 'REQUESTED', leaseOwner: 'other', attempts: 1 });
      expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(1);
    });

    it('a REJECTED request is never reopened: neither a customer request nor the reconciler claims or processes it', async () => {
      const t = build();
      t.inventory.releaseAllUnlessDispatched.mockRejectedValueOnce(dispatched());
      expect(await start(t.workflow)).toBe('REJECTED');
      const claim = jest.spyOn(t.requests, 'claim');
      expect(await start(t.workflow)).toBe('REJECTED');
      expect(claim).not.toHaveBeenCalled();
      expect(await t.workflow.resume(only(t.requests).id)).toBe('BUSY'); // claim refuses a terminal phase
      expect(only(t.requests)).toMatchObject({ phase: 'REJECTED', leaseOwner: null });
      expect(t.inventory.releaseAllUnlessDispatched).toHaveBeenCalledTimes(1);
      expect(t.orders.updateStatus).not.toHaveBeenCalled();
    });
  });

  it('start re-validates the order first: a non-cancellable status records nothing', async () => {
    const t = build('READY');
    await expect(start(t.workflow)).rejects.toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED' });
    expect(t.requests.rows.size).toBe(0);
  });

  it('classification: dispatched / transient / permanent, and id-free codes', () => {
    expect(classifyCancellationFailure(dispatched())).toBe('DISPATCHED');
    for (const e of [Object.assign(new Error(), { code: 'P2028' }), Object.assign(new Error(), { code: 'P2034' }), new ApiException(ErrorCode.CONFLICT, 'x'), new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'x'), new Error('?')]) {
      expect(classifyCancellationFailure(e)).toBe('TRANSIENT');
    }
    for (const c of [ErrorCode.LISTING_NOT_FOUND, ErrorCode.RESERVATION_NOT_FOUND, ErrorCode.VALIDATION_ERROR, ErrorCode.CANCELLATION_NOT_ALLOWED]) {
      expect(classifyCancellationFailure(new ApiException(c, 'x'))).toBe('PERMANENT');
    }
    expect(cancellationFailureCode(new ApiException(ErrorCode.LISTING_NOT_FOUND, 'x'))).toBe('LISTING_NOT_FOUND');
    expect(cancellationFailureCode(Object.assign(new Error('x'), { code: 'P1001' }))).toBe('P1001');
    expect(cancellationFailureCode(Object.assign(new Error('x'), { code: 'some id 123e4567' }))).toBe('UNKNOWN');
  });
});
