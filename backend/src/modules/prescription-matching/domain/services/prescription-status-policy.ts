import { PrescriptionMatchingErrors } from '../errors';
import { PrescriptionStatus } from '../enums';

/**
 * Pure state machine for `Prescription.status` (module-05 §3.11 invariants 1/2/4, §4, §8.1 step
 * 7, §10.1). Slice 1's write-time transition graph, exactly as narrated by the spec's flow — no
 * additional transitions are inferred beyond what the document's body text describes:
 *  - `UPLOADED -> PENDING_VERIFICATION`: `AssignVerifyingPharmacyCommand` (§4 step 3).
 *  - `PENDING_VERIFICATION -> APPROVED | REJECTED | CLARIFICATION_REQUESTED`: the three
 *    verification decisions (§10.2).
 *  - `CLARIFICATION_REQUESTED -> PENDING_VERIFICATION | UPLOADED`: reupload (§10.1) — the target
 *    depends on whether a pharmacy has already been assigned, decided by the (not-yet-built)
 *    application-layer command, not by this policy.
 *  - `APPROVED -> CONSUMED`: the dispense-exhaustion cascade for a fully-dispensed, single-use
 *    line (§8.1 step 7).
 * `REJECTED` and `CONSUMED` are terminal (no legal outgoing transition). `EXPIRED` is **not**
 * reachable by any command in Slice 1 — expiry is a derived, non-persisted `displayStatus`
 * computed at read time (§20 Decision 5, §3.11 invariant 4), never a real column write — so it
 * has no outgoing transitions here either, and nothing ever transitions *into* it via this
 * policy. `DOCTOR_ISSUED` is a schema-level enum value with no defined role anywhere in this
 * slice's narrated flow and is likewise absent from this transition graph, not inferred.
 */
const LEGAL_TRANSITIONS: Record<PrescriptionStatus, ReadonlySet<PrescriptionStatus>> = {
  [PrescriptionStatus.UPLOADED]: new Set([PrescriptionStatus.PENDING_VERIFICATION]),
  [PrescriptionStatus.PENDING_VERIFICATION]: new Set([
    PrescriptionStatus.APPROVED,
    PrescriptionStatus.REJECTED,
    PrescriptionStatus.CLARIFICATION_REQUESTED,
  ]),
  [PrescriptionStatus.CLARIFICATION_REQUESTED]: new Set([
    PrescriptionStatus.PENDING_VERIFICATION,
    PrescriptionStatus.UPLOADED,
  ]),
  [PrescriptionStatus.APPROVED]: new Set([PrescriptionStatus.CONSUMED]),
  [PrescriptionStatus.REJECTED]: new Set(),
  [PrescriptionStatus.CONSUMED]: new Set(),
  [PrescriptionStatus.EXPIRED]: new Set(),
  [PrescriptionStatus.DOCTOR_ISSUED]: new Set(),
};

export const PrescriptionStatusPolicy = {
  isLegalTransition(from: PrescriptionStatus, to: PrescriptionStatus): boolean {
    return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
  },

  assertValidTransition(from: PrescriptionStatus, to: PrescriptionStatus): void {
    if (!PrescriptionStatusPolicy.isLegalTransition(from, to)) {
      throw PrescriptionMatchingErrors.invalidPrescriptionStateTransition(from, to);
    }
  },
};
