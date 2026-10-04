import { VerificationStatus } from '../../../identity/application/ports/inbound/identity-admin.port';

/**
 * Read-side aging for a verification request (module-16 §3.1 F-AD-03's "track SLA/aging",
 * narrowed to what existing timestamps can say).
 *
 * Derived on every read from `submittedAt` and `reviewedAt` — nothing is stored, no scheduler
 * runs, no threshold is applied. An SLA is a product rule nobody has specified; the number a
 * reviewer needs today is "how long has this been waiting", and that is arithmetic.
 */
export interface VerificationAging {
  /** `submittedAt` while the request is still open; `null` once it has been decided. */
  pendingSince: Date | null;
  /**
   * Seconds from submission to now for an open request, or to the decision for a closed one —
   * so the same field reads as "waiting for" on the queue and "took" on the history.
   */
  ageSeconds: number;
}

export function computeAging(
  request: { status: VerificationStatus; submittedAt: Date; reviewedAt: Date | null },
  now: Date = new Date(),
): VerificationAging {
  const open = request.status === VerificationStatus.PENDING;
  const end = open ? now : (request.reviewedAt ?? now);
  const elapsedMs = end.getTime() - request.submittedAt.getTime();
  return {
    pendingSince: open ? request.submittedAt : null,
    // Clock skew between the writer and this reader can make a fresh submission look like it
    // was made a moment in the future; a negative age is never a useful answer.
    ageSeconds: Math.max(0, Math.floor(elapsedMs / 1000)),
  };
}
