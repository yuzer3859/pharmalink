import { VerificationDecision } from '../enums';

export const VERIFICATION_REPOSITORY = Symbol('VERIFICATION_REPOSITORY');

/** One immutable `VerificationReview` row (module-05 §3.3). */
export interface VerificationReviewSnapshot {
  id: string;
  prescriptionId: string;
  reviewerUserId: string;
  pharmacyId: string | null;
  decision: VerificationDecision;
  reason: string | null;
  legibilityOk: boolean | null;
  validityOk: boolean | null;
  reviewedAt: Date;
}

/** Data required to append one review decision (§5.2, §12). */
export interface NewVerificationReviewData {
  prescriptionId: string;
  reviewerUserId: string;
  pharmacyId?: string | null;
  decision: VerificationDecision;
  reason?: string | null;
  legibilityOk?: boolean | null;
  validityOk?: boolean | null;
}

/**
 * Persistence port for the append-style `VerificationReview` trail (module-05 §3.3) — a
 * Prescription may accumulate multiple rows over its lifetime (e.g. `CLARIFICATION` → re-upload
 * → `APPROVED`), each immutable once written; there is no update/delete method by design,
 * mirroring the same append-only discipline as `IDispenseLedgerRepository` (ADR-006).
 *
 * `create` accepts an optional `tx` handle so it can be composed with `IPrescriptionRepository`
 * calls inside the same `Serializable` "Approve/Reject prescription" transaction (§2.1.1, §12).
 */
export interface IVerificationRepository {
  create(data: NewVerificationReviewData, tx?: unknown): Promise<VerificationReviewSnapshot>;
  listByPrescriptionId(prescriptionId: string, tx?: unknown): Promise<VerificationReviewSnapshot[]>;
}
