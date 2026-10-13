import { DeliveryJobStatus } from '../../../domain/enums';

export const DELIVERY_BACKLOG_SUMMARY_READ_PORT = Symbol('DELIVERY_BACKLOG_SUMMARY_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export { DeliveryJobStatus } from '../../../domain/enums';

/**
 * Counts and timestamps over every delivery job (`delivery_jobs` has no soft delete), from one SQL
 * statement — one snapshot, `generatedAt` from the same clock.
 *
 * - `byStatus` — the stored `DeliveryJobStatus`, every value in declaration order, zero-filled.
 * - `nonTerminalCount` — jobs whose status is not terminal by `DeliveryStatusPolicy.isTerminal`
 *   (no outgoing transition: COMPLETED, CANCELLED, FAILED). DELIVERED is *not* terminal — it still
 *   moves to COMPLETED.
 * - `oldestNonTerminalCreatedAt` / `oldestNonTerminalAgeSeconds` — the earliest `createdAt` among
 *   those, and whole seconds from it to `generatedAt` (floored, never negative); both `null` when
 *   no job is non-terminal.
 * - `assignment.unassignedCount` — non-terminal jobs whose `assignedDriverId` is null. Assignment is
 *   that column, not a status: `DeliveryJob` clears it on release to REASSIGNING and sets it on
 *   ASSIGNED.
 *
 * No ETA metric: `delivery_jobs.etaAt` is a Phase-0 column nothing in Module 08 writes — the ETA is
 * computed live by `EtaService` and cached outside the database — so "overdue" has no stored basis.
 */
export interface DeliveryBacklogSummary {
  generatedAt: Date;
  jobs: {
    total: number;
    byStatus: Record<DeliveryJobStatus, number>;
    nonTerminalCount: number;
    oldestNonTerminalCreatedAt: Date | null;
    oldestNonTerminalAgeSeconds: number | null;
  };
  assignment: {
    unassignedCount: number;
  };
}

/**
 * Module 08's exported contract for the **read-only delivery backlog summary**, consumed in-process
 * by Module 16 (module-16 Work 40). One aggregate, nothing per job. It writes nothing.
 */
export interface IDeliveryBacklogSummaryReadPort {
  summarizeBacklog(): Promise<DeliveryBacklogSummary>;
}
