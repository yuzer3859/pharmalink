import { DeclineRecoverySegment, DeclineRecoveryState } from '../../services/decline-recovery.classifier';

export const DECLINE_RECOVERY_READ_PORT = Symbol('DECLINE_RECOVERY_READ_PORT');

export type { DeclineRecoverySegment, DeclineRecoveryState };

export interface DeclineRecoveryPage {
  generatedAt: Date;
  /** Segments of this page's candidate orders (filtered by `state` when given). */
  items: DeclineRecoverySegment[];
  /**
   * Per-state segment counts over THIS PAGE's candidate orders only — not global totals. Classifying
   * every candidate needs Module 04's reservation state for all of them, an unbounded cross-module read
   * per request, so the view does not compute global per-state counts. Always `countsScope: 'CURRENT_PAGE'`.
   */
  pageCounts: Record<DeclineRecoveryState, number>;
  countsScope: 'CURRENT_PAGE';
  /** Candidate orders in total — a global count (live, declined at least once, not being cancelled). */
  totalOrders: number;
  page: number;
  size: number;
}

/**
 * Module 06's derived, read-only view of pharmacy-decline recovery (Work 55), for Module 16. Paged over
 * candidate ORDERS (by id); each page lists every affected segment of those orders. Ids, statuses,
 * timestamps and a diagnostic code only — no customer data, cancellation reason or lease internals.
 */
export interface IDeclineRecoveryReadPort {
  list(filter: { state?: DeclineRecoveryState }, page: number, size: number): Promise<DeclineRecoveryPage>;
}
