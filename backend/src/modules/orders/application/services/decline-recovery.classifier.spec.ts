import { ReservationStatusView } from '../../../pharmacy-inventory/application/ports/inbound/reservation-status-read.port';
import { DeclineCandidateOrder } from '../../domain/repositories/decline-recovery.repository';
import { classifyDeclineOrder } from './decline-recovery.classifier';

const t = (s: number) => new Date(Date.UTC(2026, 9, 20, 10, 0, s));
const declined = { id: 'f-declined', status: 'CANCELLED', pharmacyId: 'ph-A', branchId: 'br-A', createdAt: t(0) };
const replacement = { id: 'f-new', status: 'PENDING', pharmacyId: 'ph-B', branchId: 'br-B', createdAt: t(10) };
const line = (over: Partial<DeclineCandidateOrder['lines'][number]> = {}) => ({
  id: 'l1', fulfillmentId: 'f-new', pharmacyId: 'ph-B', branchId: 'br-B', reservationId: 'r-new', createdAt: t(0), ...over,
});
const res = (over: Partial<ReservationStatusView> = {}): ReservationStatusView => ({
  reservationId: 'r-new', listingId: 'lst-B', branchId: 'br-B', status: 'HELD', expiresAt: t(900), dispatched: false, ...over,
});
const order = (fulfillments = [declined, replacement], lines = [line()]): DeclineCandidateOrder => ({ id: 'o1', status: 'PAID', fulfillments, lines });
const classify = (o: DeclineCandidateOrder, rs: ReservationStatusView[]) => classifyDeclineOrder(o, new Map(rs.map((r) => [r.reservationId, r])));

describe('classifyDeclineOrder (Work 55)', () => {
  it('PENDING_CONFIRMATION only for a proven post-Phase-3a replacement that is still HELD on a live fulfillment', () => {
    const [s] = classify(order(), [res()]);
    expect(s).toMatchObject({ state: 'PENDING_CONFIRMATION', diagnosticCode: 'REPLACEMENT_HELD', fulfillmentId: 'f-new', reservationId: 'r-new', listingId: 'lst-B' });
    for (const status of ['ACCEPTED', 'PREPARING']) {
      expect(classify(order([declined, { ...replacement, status }]), [res()])[0].state).toBe('PENDING_CONFIRMATION');
    }
  });

  it('RESOLVED when the replacement is CONFIRMED (dispatched or not) — a fully completed decline is not flagged', () => {
    expect(classify(order(), [res({ status: 'CONFIRMED' })])[0]).toMatchObject({ state: 'RESOLVED', diagnosticCode: 'CONFIRMED' });
    expect(classify(order(), [res({ status: 'CONFIRMED', dispatched: true })])[0]).toMatchObject({ state: 'RESOLVED', diagnosticCode: 'CONFIRMED_DISPATCHED' });
  });

  it('CONFIRMATION_FAILED for a RELEASED/EXPIRED replacement — never revived', () => {
    expect(classify(order(), [res({ status: 'EXPIRED' })])[0]).toMatchObject({ state: 'CONFIRMATION_FAILED', diagnosticCode: 'RESERVATION_EXPIRED' });
    expect(classify(order(), [res({ status: 'RELEASED' })])[0]).toMatchObject({ state: 'CONFIRMATION_FAILED', diagnosticCode: 'RESERVATION_RELEASED' });
  });

  it('anything not provably consistent is left for an operator, not confirmed', () => {
    expect(classify(order(), [res({ branchId: 'br-X' })])[0].diagnosticCode).toBe('INCONSISTENT_SEGMENT'); // listing at another branch
    expect(classify(order(undefined, [line({ pharmacyId: 'ph-X' })]), [res()])[0].diagnosticCode).toBe('INCONSISTENT_SEGMENT');
    expect(classify(order(), [])[0]).toMatchObject({ state: 'CONFIRMATION_FAILED', diagnosticCode: 'RESERVATION_NOT_FOUND' });
    expect(classify(order([declined, { ...replacement, status: 'READY' }]), [res()])[0].diagnosticCode).toBe('HELD_ON_NON_LIVE_FULFILLMENT');
    expect(classify(order(undefined, [line({ fulfillmentId: 'f-gone' })]), [res()])[0].diagnosticCode).toBe('LINE_WITHOUT_FULFILLMENT');
  });

  it('a HELD reservation on a fulfillment that is NOT a decline replacement (created before the cancelled one) is never confirmable', () => {
    const early = { ...replacement, createdAt: t(-5) };
    expect(classify(order([declined, early]), [res()])[0]).toMatchObject({ state: 'CONFIRMATION_FAILED', diagnosticCode: 'UNEXPECTED_RESERVATION_STATE' });
    expect(classify(order([declined, early]), [res({ status: 'CONFIRMED' })])).toEqual([]); // unrelated, fine: omitted
  });

  it('ORPHANED: a line still on the cancelled fulfillment (decline stopped before Phase 3a)', () => {
    const [s] = classify(order([declined], [line({ fulfillmentId: 'f-declined', pharmacyId: 'ph-A', branchId: 'br-A', reservationId: 'r-old' })]), [res({ reservationId: 'r-old', status: 'RELEASED' })]);
    expect(s).toMatchObject({ state: 'ORPHANED', diagnosticCode: 'LINE_ON_CANCELLED_FULFILLMENT', fulfillmentId: 'f-declined', reservationStatus: 'RELEASED' });
  });

  it('multi-pharmacy: another live (original) fulfillment does not hide the stranded declined segment', () => {
    const other = { id: 'f-other', status: 'ACCEPTED', pharmacyId: 'ph-C', branchId: 'br-C', createdAt: t(0) };
    const o = order([declined, other], [
      line({ id: 'l-stranded', fulfillmentId: 'f-declined', pharmacyId: 'ph-A', branchId: 'br-A', reservationId: 'r-old' }),
      line({ id: 'l-other', fulfillmentId: 'f-other', pharmacyId: 'ph-C', branchId: 'br-C', reservationId: 'r-other' }),
    ]);
    const segs = classify(o, [res({ reservationId: 'r-old', status: 'RELEASED' }), res({ reservationId: 'r-other', branchId: 'br-C', status: 'CONFIRMED' })]);
    expect(segs.map((s) => [s.lineId, s.state])).toEqual([['l-stranded', 'ORPHANED']]);
  });
});
