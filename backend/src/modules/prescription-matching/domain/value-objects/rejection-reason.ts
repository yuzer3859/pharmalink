import { PrescriptionMatchingErrors } from '../errors';

/**
 * Non-empty, trimmed string wrapper for a prescription rejection reason (module-05 §3.8,
 * BRULE-14). Mirrors Module 04's `AdjustBatchDto.reason` mandatory-reason pattern. Construction
 * is the single source of truth for "a REJECTED transition requires a non-empty reason"
 * (§3.11 invariant 2) — an absent/whitespace-only reason throws `REJECTION_REASON_REQUIRED`
 * here, at the command layer's single point of truth, not just via DTO validation (which alone
 * would not stop a programmatic/internal caller).
 */
export class RejectionReason {
  private static readonly MIN_LENGTH = 3;
  private static readonly MAX_LENGTH = 500;

  private constructor(readonly value: string) {}

  static of(raw: string | null | undefined): RejectionReason {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length === 0) {
      throw PrescriptionMatchingErrors.rejectionReasonRequired();
    }
    if (
      trimmed.length < RejectionReason.MIN_LENGTH ||
      trimmed.length > RejectionReason.MAX_LENGTH
    ) {
      throw PrescriptionMatchingErrors.validation(
        `Rejection reason must be between ${RejectionReason.MIN_LENGTH} and ${RejectionReason.MAX_LENGTH} characters.`,
        { field: 'reason' },
      );
    }
    return new RejectionReason(trimmed);
  }
}
