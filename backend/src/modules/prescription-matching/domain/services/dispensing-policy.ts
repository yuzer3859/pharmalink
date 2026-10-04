import { PrescriptionMatchingErrors } from '../errors';

export type DispenseDecision = 'OK' | 'EXHAUSTED' | 'EXPIRED';

export interface DispensableLine {
  remainingDispensable: number;
  /** Parent prescription's `expiryDate`, if any — `null` means "no stated expiry" (§20 Decision 2). */
  expiryDate: Date | null;
}

/**
 * Anti-reuse dispensing eligibility (module-05 §3.9, §3.11 invariants 3/4, §8.1 step 4). This
 * function itself is pure and performs no I/O — the application layer is responsible for
 * re-reading `DispensableLine` fresh, inside the same `Serializable` transaction as the dispense
 * write (§8.1), before calling this. Expiry is checked before exhaustion because an expired
 * prescription can never be dispensed against regardless of remaining quantity (§3.11 invariant
 * 4 — status is not proactively swept to `EXPIRED`, so this check must always be live at
 * dispense time, never trusted from a stale read).
 */
export const DispensingPolicy = {
  canDispense(
    line: DispensableLine,
    requestedQuantity: number,
    now: Date = new Date(),
  ): DispenseDecision {
    if (line.expiryDate && line.expiryDate.getTime() <= now.getTime()) {
      return 'EXPIRED';
    }
    if (requestedQuantity > line.remainingDispensable) {
      return 'EXHAUSTED';
    }
    return 'OK';
  },

  assertCanDispense(
    line: DispensableLine,
    requestedQuantity: number,
    now: Date = new Date(),
  ): void {
    const decision = DispensingPolicy.canDispense(line, requestedQuantity, now);
    if (decision === 'EXPIRED') {
      throw PrescriptionMatchingErrors.prescriptionExpired();
    }
    if (decision === 'EXHAUSTED') {
      throw PrescriptionMatchingErrors.prescriptionExhausted();
    }
  },
};
