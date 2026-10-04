import { PrescriptionMatchingErrors } from '../errors';

export interface ReviewableProps {
  customerUserId: string;
}

/**
 * Model A verification eligibility (module-05 §3.9, §4, §3.11 invariant 1). A review is legal
 * only when BOTH hold:
 *  1. the reviewer is not the uploading customer (self-review guard — mirrors Module 01's
 *     `VerificationRequest.assertReviewable`'s identical guard; an independently owned copy per
 *     ADR-002, not a shared import);
 *  2. the reviewer holds the `PHARMACIST` role at the prescription's `verifyingPharmacyId`
 *     organization (org-scoping guard) — computed by the application layer via
 *     `IIdentityPort.hasRoleAtOrganization()` (§2.1, not implemented in this task) and passed in
 *     as `isPharmacistAtPharmacy`, since only the application layer can reach identity/RBAC
 *     data; this policy stays pure and framework-free.
 * Both conditions are required together — callers must never check only one of them, since
 * either gap alone reopens BRULE-10's "licensed pharmacist" requirement.
 *
 * Prescription status (`PENDING_VERIFICATION`) is deliberately **not** checked here — that is a
 * separate, differently-coded failure (`409 INVALID_PRESCRIPTION_STATE_TRANSITION` via
 * `PrescriptionStatusPolicy`, §5.2), not a `403 VERIFICATION_FORBIDDEN` reviewer-eligibility
 * failure. Keeping the two checks separate lets the future command layer report the correct,
 * specific error for each case rather than collapsing both into one generic "forbidden".
 */
export const VerificationPolicy = {
  canReview(
    reviewerUserId: string,
    prescription: ReviewableProps,
    isPharmacistAtPharmacy: boolean,
  ): boolean {
    if (reviewerUserId === prescription.customerUserId) {
      return false;
    }
    return isPharmacistAtPharmacy;
  },

  assertCanReview(
    reviewerUserId: string,
    prescription: ReviewableProps,
    isPharmacistAtPharmacy: boolean,
  ): void {
    if (!VerificationPolicy.canReview(reviewerUserId, prescription, isPharmacistAtPharmacy)) {
      throw PrescriptionMatchingErrors.verificationForbidden();
    }
  },
};
