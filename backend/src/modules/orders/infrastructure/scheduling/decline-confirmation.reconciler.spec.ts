import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { DeclineCandidateOrder } from '../../domain/repositories/decline-recovery.repository';
import { DeclineConfirmationReconciler } from './decline-confirmation.reconciler';

const at = (s: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, s));
const candidate = (id: string, reservationId = `r-${id}`, lineFulfillment = 'f-new'): DeclineCandidateOrder => ({
  id,
  status: 'PAID',
  fulfillments: [
    { id: 'f-old', status: 'CANCELLED', pharmacyId: 'ph-A', branchId: 'br-A', createdAt: at(0) },
    { id: 'f-new', status: 'PENDING', pharmacyId: 'ph-B', branchId: 'br-B', createdAt: at(10) },
  ],
  lines: [{ id: `l-${id}`, fulfillmentId: lineFulfillment, pharmacyId: lineFulfillment === 'f-new' ? 'ph-B' : 'ph-A', branchId: lineFulfillment === 'f-new' ? 'br-B' : 'br-A', reservationId, createdAt: at(0) }],
});

function build(orders: DeclineCandidateOrder[], statuses: Record<string, string>) {
  const candidates = {
    listCandidates: jest.fn<Promise<DeclineCandidateOrder[]>, [string | null, number]>(async () => orders),
    findCandidate: jest.fn(async (id: string) => orders.find((o) => o.id === id) ?? null),
    pageCandidates: jest.fn(),
  };
  const reservations = {
    findReservations: jest.fn(async (ids: string[]) =>
      ids.filter((id) => statuses[id]).map((id) => ({ reservationId: id, listingId: 'lst', branchId: id.includes('old') ? 'br-A' : 'br-B', status: statuses[id], expiresAt: at(900), dispatched: false })),
    ),
  };
  const inventory = { confirm: jest.fn().mockResolvedValue(undefined) };
  const reconciler = new DeclineConfirmationReconciler(candidates as never, reservations as never, inventory as never);
  return { reconciler, candidates, reservations, inventory };
}

describe('DeclineConfirmationReconciler (Work 55)', () => {
  it('confirms only proven, still-HELD replacements (after re-checking each), counting every other state', async () => {
    const t = build(
      [candidate('a'), candidate('b'), candidate('c'), candidate('d', 'r-old-d', 'f-old')],
      { 'r-a': 'HELD', 'r-b': 'CONFIRMED', 'r-c': 'EXPIRED', 'r-old-d': 'RELEASED' },
    );
    const report = await t.reconciler.run(10);
    expect(t.inventory.confirm.mock.calls).toEqual([[{ reservationId: 'r-a' }]]);
    expect(t.candidates.findCandidate).toHaveBeenCalledWith('a');
    expect(report).toEqual({ examinedOrders: 4, confirmed: 1, alreadyConfirmed: 1, failed: 1, orphaned: 1, skipped: 0, errors: 0 });
  });

  it('skips when the order stopped being a candidate (e.g. cancellation opened) or the line changed before the confirm', async () => {
    const t = build([candidate('a')], { 'r-a': 'HELD' });
    t.candidates.findCandidate.mockResolvedValueOnce(null);
    expect(await t.reconciler.run()).toMatchObject({ skipped: 1, confirmed: 0 });
    t.candidates.findCandidate.mockResolvedValueOnce({ ...candidate('a'), lines: [{ ...candidate('a').lines[0], reservationId: 'r-other' }] });
    expect(await t.reconciler.run()).toMatchObject({ skipped: 1, confirmed: 0 });
    expect(t.inventory.confirm).not.toHaveBeenCalled();
  });

  it('a confirm refused as released or expired is a failure (never retried into a revival); other errors are retried next run; it never throws', async () => {
    const t = build([candidate('a'), candidate('b')], { 'r-a': 'HELD', 'r-b': 'HELD' });
    t.inventory.confirm
      .mockRejectedValueOnce(new ApiException(ErrorCode.INVALID_RESERVATION_STATE, 'released'))
      .mockRejectedValueOnce(new Error('connection reset'));
    expect(await t.reconciler.run()).toMatchObject({ failed: 1, errors: 1, confirmed: 0 });

    const broken = build([], {});
    broken.candidates.listCandidates.mockRejectedValueOnce(new Error('db down'));
    expect(await broken.reconciler.run()).toMatchObject({ errors: 1, examinedOrders: 0 });
  });

  it('keyset paging: a full page continues from its last order id; a short one wraps to the start', async () => {
    const t = build([candidate('a'), candidate('b')], {});
    await t.reconciler.run(2);
    await t.reconciler.run(2);
    expect(t.candidates.listCandidates.mock.calls.map((c) => c[0])).toEqual([null, 'b']);
  });

  it('an overlapping run in the same process returns at once', async () => {
    const t = build([candidate('a')], { 'r-a': 'HELD' });
    let release!: () => void;
    t.inventory.confirm.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = t.reconciler.run();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(await t.reconciler.run()).toMatchObject({ examinedOrders: 0 });
    release();
    expect(await first).toMatchObject({ confirmed: 1 });
  });
});
