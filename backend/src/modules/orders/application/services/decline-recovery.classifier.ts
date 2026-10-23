import { ReservationStatusView } from '../../../pharmacy-inventory/application/ports/inbound/reservation-status-read.port';
import { DeclineCandidateOrder } from '../../domain/repositories/decline-recovery.repository';

/**
 * Where one order line of a declined order stands (Work 55):
 *  - `PENDING_CONFIRMATION` — PROVEN post-Phase-3a and safely confirmable: the line sits on a live
 *    fulfillment created after one of the order's cancelled fulfillments, the line's pharmacy/branch
 *    match that fulfillment (Phase 3a writes them together), the reservation's listing is at that
 *    branch, and the reservation is still `HELD`. The only state the reconciler acts on.
 *  - `CONFIRMATION_FAILED` — a replacement the order depends on is `RELEASED`/`EXPIRED`, or the segment is
 *    not consistent enough to prove anything (missing reservation, branch mismatch, a HELD reservation on
 *    a non-replacement fulfillment). Never touched automatically.
 *  - `ORPHANED` — the line is still on a `CANCELLED` fulfillment: the decline stopped before Phase 3a
 *    re-pointed it. Operator-actionable; never re-matched or re-pointed automatically.
 *  - `RESOLVED` — the replacement is `CONFIRMED` (dispatched or not) and the segment is consistent.
 * Lines on a fulfillment that is not a decline replacement and whose stock is confirmed are not part of
 * the decline and are omitted — so a multi-pharmacy order still shows only its affected segment.
 */
export type DeclineRecoveryState = 'PENDING_CONFIRMATION' | 'CONFIRMATION_FAILED' | 'ORPHANED' | 'RESOLVED';

export interface DeclineRecoverySegment {
  orderId: string;
  orderStatus: string;
  lineId: string;
  fulfillmentId: string | null;
  fulfillmentStatus: string | null;
  fulfillmentCreatedAt: Date | null;
  reservationId: string | null;
  listingId: string | null;
  reservationStatus: string | null;
  reservationExpiresAt: Date | null;
  state: DeclineRecoveryState;
  /** A safe, structured reason — never free text. */
  diagnosticCode: string;
}

const CONFIRMABLE_FULFILLMENT = new Set(['PENDING', 'ACCEPTED', 'PREPARING']);

export function classifyDeclineOrder(order: DeclineCandidateOrder, reservations: Map<string, ReservationStatusView>): DeclineRecoverySegment[] {
  const byId = new Map(order.fulfillments.map((f) => [f.id, f]));
  const cancelled = order.fulfillments.filter((f) => f.status === 'CANCELLED');
  const firstCancelledAt = cancelled.length ? Math.min(...cancelled.map((f) => f.createdAt.getTime())) : null;
  const segments: DeclineRecoverySegment[] = [];

  for (const line of order.lines) {
    const f = line.fulfillmentId ? byId.get(line.fulfillmentId) ?? null : null;
    const r = line.reservationId ? reservations.get(line.reservationId) ?? null : null;
    const seg = (state: DeclineRecoveryState, diagnosticCode: string): DeclineRecoverySegment => ({
      orderId: order.id,
      orderStatus: order.status,
      lineId: line.id,
      fulfillmentId: f?.id ?? line.fulfillmentId,
      fulfillmentStatus: f?.status ?? null,
      fulfillmentCreatedAt: f?.createdAt ?? null,
      reservationId: line.reservationId,
      listingId: r?.listingId ?? null,
      reservationStatus: r?.status ?? null,
      reservationExpiresAt: r?.expiresAt ?? null,
      state,
      diagnosticCode,
    });

    if (!f) {
      segments.push(seg('CONFIRMATION_FAILED', 'LINE_WITHOUT_FULFILLMENT'));
      continue;
    }
    if (f.status === 'CANCELLED') {
      segments.push(seg('ORPHANED', 'LINE_ON_CANCELLED_FULFILLMENT'));
      continue;
    }
    // A decline replacement: created after one of the order's cancelled fulfillments.
    const isReplacement = firstCancelledAt !== null && f.createdAt.getTime() > firstCancelledAt;
    if (!line.reservationId) {
      if (isReplacement) segments.push(seg('RESOLVED', 'NO_RESERVATION'));
      continue;
    }
    if (!r) {
      segments.push(seg('CONFIRMATION_FAILED', 'RESERVATION_NOT_FOUND'));
      continue;
    }
    if (!isReplacement) {
      // Not part of a decline cycle: fine when confirmed; anything else is not ours to touch.
      if (r.status !== 'CONFIRMED') segments.push(seg('CONFIRMATION_FAILED', 'UNEXPECTED_RESERVATION_STATE'));
      continue;
    }
    const consistent = line.pharmacyId === f.pharmacyId && line.branchId === f.branchId && r.branchId === f.branchId;
    if (!consistent) {
      segments.push(seg('CONFIRMATION_FAILED', 'INCONSISTENT_SEGMENT'));
    } else if (r.status === 'CONFIRMED') {
      segments.push(seg('RESOLVED', r.dispatched ? 'CONFIRMED_DISPATCHED' : 'CONFIRMED'));
    } else if (r.status === 'HELD') {
      segments.push(
        CONFIRMABLE_FULFILLMENT.has(f.status)
          ? seg('PENDING_CONFIRMATION', 'REPLACEMENT_HELD')
          : seg('CONFIRMATION_FAILED', 'HELD_ON_NON_LIVE_FULFILLMENT'),
      );
    } else {
      segments.push(seg('CONFIRMATION_FAILED', r.status === 'EXPIRED' ? 'RESERVATION_EXPIRED' : 'RESERVATION_RELEASED'));
    }
  }
  return segments;
}
