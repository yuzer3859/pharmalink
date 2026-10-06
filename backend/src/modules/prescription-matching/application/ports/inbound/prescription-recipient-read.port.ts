export const PRESCRIPTION_RECIPIENT_READ_PORT = Symbol('PRESCRIPTION_RECIPIENT_READ_PORT');

/**
 * Module 05's exported contract for **whose prescription or match request this is**, consumed
 * in-process by Module 13 to address prescription and matching notifications (module-13 Work 06).
 * `prescription.approved` / `.rejected` name only the prescription and `matching.match_failed`
 * only the match request; Module 05 stays the only module that reads either table.
 *
 * One column per question, read-only: no file reference, line, medicine, quantity, reviewer,
 * verifying pharmacy, candidate or chosen result crosses this seam.
 */
export interface IPrescriptionRecipientReadPort {
  /** The prescription's `customerUserId`, or `null` when no such prescription exists. */
  customerUserIdOfPrescription(prescriptionId: string): Promise<string | null>;
  /** The match request's `customerUserId`, or `null` when no such match request exists. */
  customerUserIdOfMatchRequest(matchRequestId: string): Promise<string | null>;
}
