import { PrescriptionMatchingErrors } from '../errors';

/**
 * Non-negative integer wrapper over a prescription line's remaining dispensable quantity
 * (module-05 §3.8, §3.11 invariant 3). `RemainingDispensable.compute(approvedQuantity,
 * dispensedSum)` is the single source of truth for `remainingDispensable = approvedQuantity -
 * Σ(dispensed)`; it never returns a negative value — if `dispensedSum` somehow exceeds
 * `approvedQuantity` (which should never happen if the dispense-time invariant holds, §3.11.3),
 * this is a defensive assertion, not a normal code path, and throws rather than silently
 * clamping the error away (mirrors the "invariant violation, asserted rather than silently
 * floored" pattern already used in `modules/pharmacy-inventory`'s dispatch/release commands).
 */
export class RemainingDispensable {
  private constructor(readonly value: number) {}

  static compute(approvedQuantity: number, dispensedSum: number): RemainingDispensable {
    if (!Number.isInteger(approvedQuantity) || approvedQuantity < 0) {
      throw PrescriptionMatchingErrors.validation(
        'approvedQuantity must be a non-negative integer.',
        { field: 'approvedQuantity' },
      );
    }
    if (!Number.isInteger(dispensedSum) || dispensedSum < 0) {
      throw PrescriptionMatchingErrors.validation('dispensedSum must be a non-negative integer.', {
        field: 'dispensedSum',
      });
    }
    if (dispensedSum > approvedQuantity) {
      throw PrescriptionMatchingErrors.validation(
        'Invariant violation: dispensedSum cannot exceed approvedQuantity (BRULE-12).',
        { approvedQuantity, dispensedSum },
      );
    }
    return new RemainingDispensable(Math.max(0, approvedQuantity - dispensedSum));
  }

  isExhausted(): boolean {
    return this.value === 0;
  }

  covers(requestedQuantity: number): boolean {
    return this.value >= requestedQuantity;
  }
}
