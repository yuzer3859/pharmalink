import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Prescription & Matching domain/application errors (module-05 §15.2). Thrown from the domain
 * and application layers and translated to the standard error envelope by the global
 * AllExceptionsFilter, mirroring `modules/pharmacy-inventory/domain/errors.ts` and
 * `modules/catalog/domain/errors.ts`.
 */
export const PrescriptionMatchingErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  notFound: (message = 'Prescription not found', details?: unknown) =>
    new ApiException(ErrorCode.PRESCRIPTION_NOT_FOUND, message, details),

  prescriptionExpired: () =>
    new ApiException(ErrorCode.PRESCRIPTION_EXPIRED, 'This prescription has expired.'),

  prescriptionNotApproved: () =>
    new ApiException(
      ErrorCode.PRESCRIPTION_NOT_APPROVED,
      'No approved prescription line covers this product.',
    ),

  prescriptionExhausted: () =>
    new ApiException(
      ErrorCode.PRESCRIPTION_EXHAUSTED,
      'This prescription line has no remaining dispensable quantity for the requested amount.',
    ),

  rxRequired: (catalogProductId: string) =>
    new ApiException(
      ErrorCode.RX_REQUIRED,
      'A valid prescription is required for this product.',
      { catalogProductId },
    ),

  rejectionReasonRequired: () =>
    new ApiException(
      ErrorCode.REJECTION_REASON_REQUIRED,
      'A rejection reason is required to reject a prescription.',
    ),

  verificationForbidden: () =>
    new ApiException(
      ErrorCode.VERIFICATION_FORBIDDEN,
      'You are not permitted to review this prescription.',
    ),

  invalidPrescriptionStateTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_PRESCRIPTION_STATE_TRANSITION,
      `Cannot transition prescription status from ${from} to ${to}.`,
      { from, to },
    ),

  invalidMatchStateTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_MATCH_STATE_TRANSITION,
      `Cannot transition match status from ${from} to ${to}.`,
      { from, to },
    ),

  noPharmacyMatch: () =>
    new ApiException(ErrorCode.NO_PHARMACY_MATCH, 'No pharmacy covers all requested lines.'),

  matchCandidateUnavailable: () =>
    new ApiException(
      ErrorCode.MATCH_CANDIDATE_UNAVAILABLE,
      'The selected match candidate is no longer available.',
    ),

  matchFailed: () =>
    new ApiException(
      ErrorCode.MATCH_FAILED,
      'This match request has failed and cannot be resumed.',
    ),

  catalogProductNotFound: () =>
    new ApiException(
      ErrorCode.CATALOG_PRODUCT_NOT_FOUND,
      'Catalog product not found or inactive.',
    ),

  /**
   * A mutation's `Serializable` transaction (state change + audit + outbox, ADR-013/§2.1.1)
   * contended for longer than the bounded retry budget — e.g. a genuine concurrent write-write
   * conflict on the same `PrescriptionLine` (§8.1 step 10) or a write-conflict raised while
   * protecting the audit hash chain's "no fork" guarantee. Returned instead of a `500` so the
   * client can simply retry (§15.2 `CONFLICT`, reused generic code per §15.2's table).
   */
  concurrentModification: (details?: unknown) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This record was changed concurrently by another request. Please retry.',
      details,
    ),
};
