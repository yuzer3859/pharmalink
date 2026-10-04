import { DeliveryJobStatus } from '../enums';
import { DeliveryErrors } from '../errors';

/**
 * Pure state machine for `DeliveryJob.status` (`architecture/module-08-delivery-tracking.md`
 * §3.3 F-STS-01, §6, §11.5) — the design's `DeliveryStateMachine` domain service. No I/O, no
 * repository, no clock: it answers only "may this job go from A to B?".
 *
 * ```
 * CREATED ──► OFFERED ──► ASSIGNED ──► ARRIVED_PICKUP ──► PICKED_UP ──► EN_ROUTE
 *                                                                          │
 *                          ┌───────────────────────────────────────────────┘
 *                          ▼
 *                   ARRIVED_DROPOFF ──► DELIVERED ──► COMPLETED
 * ```
 *
 * ## The two branch rules, and why they are where they are
 *
 * **Cancellation stops at pickup.** `CANCELLED` is reachable from `CREATED`, `OFFERED`,
 * `ASSIGNED`, `ARRIVED_PICKUP` and `REASSIGNING` — every state in which nobody is yet carrying
 * the goods — and from nowhere after `PICKED_UP`. Once a driver physically holds the medicines,
 * "cancelled" would be a status that contradicts the world: the items exist, they are in a bag,
 * and they have to end up somewhere. That path is `FAILED` (§3.3 F-STS-05's "failed delivery →
 * retry/return policy"), which carries a return obligation that `CANCELLED` does not.
 *
 * **Reassignment stops at pickup too**, and this one is stated outright by the design: F-JOB-05
 * reassigns "if assigned driver goes offline/unavailable **before pickup**", and §11.5's flow is
 * "driver offline / cancels **pre-pickup**". After `PICKED_UP` a different driver cannot take
 * over without a physical handover, which the design does not define. `REASSIGNING` therefore
 * enters only from `ASSIGNED` and `ARRIVED_PICKUP`, and leaves only to `OFFERED` (re-dispatch) or
 * `CANCELLED`.
 *
 * ## What is deliberately absent
 *
 * - **`OFFERED → FAILED` and `REASSIGNING → FAILED`.** Dispatch exhaustion is *not* a failed job:
 *   §6.5 and §11.5 both say no acceptor escalates — "widen radius / notify ops / hold" — and
 *   raises `NO_DRIVER_AVAILABLE`. The job stays offerable. A job that auto-failed after N rounds
 *   would strand an order that a human could still have dispatched. If product later decides
 *   exhaustion should terminate a job, that is a new transition with a new rationale, not an
 *   omission being corrected.
 * - **`ASSIGNED → FAILED`.** A pre-pickup problem is a reassignment or a cancellation; nothing in
 *   the design describes a job failing while the goods are still on the pharmacy's shelf.
 * - **`DELIVERED → FAILED`.** Delivery is a physical fact; a dispute after the fact is Module
 *   16's `DisputeCase` and a Module 07 refund, not a rewrite of what happened here.
 *
 * `DELIVERED → COMPLETED` is kept as a distinct step rather than collapsed: `DELIVERED` is the
 * driver's assertion that the handover happened, while `COMPLETED` is the platform closing the
 * job after its settlement-side effects (earnings accrual, COD reconciliation — later works).
 * Collapsing them would leave nowhere to stand between "the customer has the medicine" and "the
 * books are square".
 */
const LEGAL_TRANSITIONS: Record<DeliveryJobStatus, ReadonlySet<DeliveryJobStatus>> = {
  [DeliveryJobStatus.CREATED]: new Set([
    DeliveryJobStatus.OFFERED,
    DeliveryJobStatus.CANCELLED,
  ]),
  [DeliveryJobStatus.OFFERED]: new Set([
    DeliveryJobStatus.ASSIGNED,
    // Re-offering after a decline or TTL expiry is a `job_offers` round, not a job transition:
    // the job stays OFFERED while the dispatcher works down its candidate list (§6.4).
    DeliveryJobStatus.CANCELLED,
  ]),
  [DeliveryJobStatus.ASSIGNED]: new Set([
    DeliveryJobStatus.ARRIVED_PICKUP,
    DeliveryJobStatus.REASSIGNING,
    DeliveryJobStatus.CANCELLED,
  ]),
  [DeliveryJobStatus.ARRIVED_PICKUP]: new Set([
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.REASSIGNING,
    DeliveryJobStatus.CANCELLED,
  ]),
  [DeliveryJobStatus.PICKED_UP]: new Set([
    DeliveryJobStatus.EN_ROUTE,
    DeliveryJobStatus.FAILED,
  ]),
  [DeliveryJobStatus.EN_ROUTE]: new Set([
    DeliveryJobStatus.ARRIVED_DROPOFF,
    DeliveryJobStatus.FAILED,
  ]),
  [DeliveryJobStatus.ARRIVED_DROPOFF]: new Set([
    DeliveryJobStatus.DELIVERED,
    DeliveryJobStatus.FAILED,
  ]),
  [DeliveryJobStatus.DELIVERED]: new Set([DeliveryJobStatus.COMPLETED]),
  [DeliveryJobStatus.REASSIGNING]: new Set([
    DeliveryJobStatus.OFFERED,
    DeliveryJobStatus.CANCELLED,
  ]),
  [DeliveryJobStatus.COMPLETED]: new Set(),
  [DeliveryJobStatus.CANCELLED]: new Set(),
  [DeliveryJobStatus.FAILED]: new Set(),
};

/**
 * The states from which a job may still be cancelled — i.e. those in which no driver is yet
 * carrying the goods. Derived from the table above rather than listed again, so the two can never
 * disagree.
 */
const CANCELLABLE: ReadonlySet<DeliveryJobStatus> = new Set(
  (Object.keys(LEGAL_TRANSITIONS) as DeliveryJobStatus[]).filter((status) =>
    LEGAL_TRANSITIONS[status].has(DeliveryJobStatus.CANCELLED),
  ),
);

/** Statuses in which a driver is assigned to the job and must be recorded on it. */
const REQUIRES_DRIVER: ReadonlySet<DeliveryJobStatus> = new Set([
  DeliveryJobStatus.ASSIGNED,
  DeliveryJobStatus.ARRIVED_PICKUP,
  DeliveryJobStatus.PICKED_UP,
  DeliveryJobStatus.EN_ROUTE,
  DeliveryJobStatus.ARRIVED_DROPOFF,
  DeliveryJobStatus.DELIVERED,
  DeliveryJobStatus.COMPLETED,
]);

export const DeliveryStatusPolicy = {
  isLegalTransition(from: DeliveryJobStatus, to: DeliveryJobStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: DeliveryJobStatus, to: DeliveryJobStatus): void {
    if (!DeliveryStatusPolicy.isLegalTransition(from, to)) {
      throw DeliveryErrors.invalidStateTransition(from, to);
    }
  },

  /** `COMPLETED`, `CANCELLED`, `FAILED` — a job in one of these never moves again. */
  isTerminal(status: DeliveryJobStatus): boolean {
    return LEGAL_TRANSITIONS[status]?.size === 0;
  },

  /** Whether the job may still be cancelled, i.e. the goods are not yet with a driver. */
  isCancellable(status: DeliveryJobStatus): boolean {
    return CANCELLABLE.has(status);
  },

  /** Whether a job in this status must carry an `assignedDriverId`. */
  requiresAssignedDriver(status: DeliveryJobStatus): boolean {
    return REQUIRES_DRIVER.has(status);
  },

  /** The legal next states, for diagnostics and for tests that must not restate the table. */
  nextStates(status: DeliveryJobStatus): DeliveryJobStatus[] {
    return [...(LEGAL_TRANSITIONS[status] ?? [])];
  },
};
