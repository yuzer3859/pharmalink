import { PrescriptionStatusPolicy } from './prescription-status-policy';
import { PrescriptionStatus } from '../enums';

describe('PrescriptionStatusPolicy', () => {
  it('allows UPLOADED -> PENDING_VERIFICATION', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.UPLOADED,
        PrescriptionStatus.PENDING_VERIFICATION,
      ),
    ).toBe(true);
  });

  it('allows PENDING_VERIFICATION -> APPROVED | REJECTED | CLARIFICATION_REQUESTED', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.PENDING_VERIFICATION,
        PrescriptionStatus.APPROVED,
      ),
    ).toBe(true);
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.PENDING_VERIFICATION,
        PrescriptionStatus.REJECTED,
      ),
    ).toBe(true);
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.PENDING_VERIFICATION,
        PrescriptionStatus.CLARIFICATION_REQUESTED,
      ),
    ).toBe(true);
  });

  it('allows CLARIFICATION_REQUESTED -> PENDING_VERIFICATION or UPLOADED (reupload)', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.CLARIFICATION_REQUESTED,
        PrescriptionStatus.PENDING_VERIFICATION,
      ),
    ).toBe(true);
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.CLARIFICATION_REQUESTED,
        PrescriptionStatus.UPLOADED,
      ),
    ).toBe(true);
  });

  it('allows APPROVED -> CONSUMED (dispense-exhaustion cascade)', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.APPROVED,
        PrescriptionStatus.CONSUMED,
      ),
    ).toBe(true);
  });

  it('rejects re-deciding an already-PENDING_VERIFICATION-exited prescription (double approve/reject race)', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.APPROVED,
        PrescriptionStatus.REJECTED,
      ),
    ).toBe(false);
  });

  it('rejects any transition out of a terminal REJECTED status', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.REJECTED,
        PrescriptionStatus.PENDING_VERIFICATION,
      ),
    ).toBe(false);
  });

  it('rejects any transition out of a terminal CONSUMED status', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.CONSUMED,
        PrescriptionStatus.APPROVED,
      ),
    ).toBe(false);
  });

  it('rejects skipping straight from UPLOADED to APPROVED', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.UPLOADED,
        PrescriptionStatus.APPROVED,
      ),
    ).toBe(false);
  });

  it('EXPIRED and DOCTOR_ISSUED have no outgoing transitions (not reachable/used in Slice 1)', () => {
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.EXPIRED,
        PrescriptionStatus.APPROVED,
      ),
    ).toBe(false);
    expect(
      PrescriptionStatusPolicy.isLegalTransition(
        PrescriptionStatus.DOCTOR_ISSUED,
        PrescriptionStatus.APPROVED,
      ),
    ).toBe(false);
  });

  it('assertValidTransition throws INVALID_PRESCRIPTION_STATE_TRANSITION for an illegal transition', () => {
    expect(() =>
      PrescriptionStatusPolicy.assertValidTransition(
        PrescriptionStatus.REJECTED,
        PrescriptionStatus.APPROVED,
      ),
    ).toThrow();
  });

  it('assertValidTransition does not throw for a legal transition', () => {
    expect(() =>
      PrescriptionStatusPolicy.assertValidTransition(
        PrescriptionStatus.UPLOADED,
        PrescriptionStatus.PENDING_VERIFICATION,
      ),
    ).not.toThrow();
  });
});
