export const DISPENSING_PORT = Symbol('DISPENSING_PORT');

/**
 * Port method input (§5.4) — not an HTTP DTO, a port method input (§10.4).
 *
 * **Deviation from §5.4's literal `DispenseMedicineInput` shape (flagged, not silently
 * guessed):** the spec's DTO has no actor field, but the `dispense_records` schema column
 * `dispensedByUserId` is `NOT NULL` (`prisma/schema/05-prescription.prisma`,
 * `IDispenseLedgerRepository.NewDispenseRecordData.dispensedByUserId: string`, required) — the
 * ledger row must record who/what performed the dispense (a pharmacy staff member, or a system
 * actor for an automated fulfillment trigger) for audit purposes (§13). This is an additive
 * field on this module's own port, not a change to any already-implemented repository contract.
 */
export interface DispenseMedicineInput {
  prescriptionLineId: string;
  /** REQUIRED — resolves §6.3's replay guard; DB-enforced via `@@unique([prescriptionLineId, idempotencyKey])`. */
  idempotencyKey: string;
  orderId: string;
  pharmacyId: string;
  quantity: number;
  /** Actor recorded on the ledger row and the `MEDICINE_DISPENSED` audit entry (see class doc above). */
  dispensedByUserId: string;
  /** Module 04 reconciliation reference (§3.11 invariant 7). */
  stockMovementId?: string;
}

export interface DispenseMedicineResult {
  dispenseRecordId: string;
}

/**
 * This module's own exported inbound contract for dispensing (module-05 §5.4, §8.1, §10.4) —
 * consumed in-process by Module 06/08 (fulfillment, future) via Nest DI, never over HTTP (same
 * reasoning as `ICheckRxGatePort`). Implemented by `DispenseMedicineCommand` (not built by this
 * task), which must:
 *  - run its transaction at `Serializable` isolation with the bounded retry wrapper
 *    (`application/support/match-retry.ts`'s `runWithMatchRetry`, §2.1.1/§8.1);
 *  - treat a `(prescriptionLineId, idempotencyKey)` collision
 *    (`IDispenseLedgerRepository.findByIdempotencyKey`) as a replay, returning the original
 *    `DispenseRecord`'s id unchanged rather than erroring (§6.3);
 *  - recompute `remainingDispensable` fresh inside that same transaction before deciding via
 *    `DispensingPolicy.assertCanDispense()` (§3.11 invariant 3, §8.1 steps 2-6).
 * This port carries none of that orchestration itself — it is purely the exported seam.
 */
export interface IDispensingPort {
  dispense(input: DispenseMedicineInput): Promise<DispenseMedicineResult>;
}
