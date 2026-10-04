import { PrescriptionMatchingErrors } from '../errors';

export interface ValidityPeriodProps {
  issueDate?: Date | null;
  expiryDate?: Date | null;
}

/**
 * `{ issueDate?, expiryDate? }` wrapper (module-05 §3.8). `expiryDate` must be on/after
 * `issueDate` when both are present (§5.1 business validation) — validated at construction so
 * no command layer needs to re-derive this rule. `isExpired(asOf)` is always `false` when
 * `expiryDate` is absent (§20 Decision 2's "no stated expiry" default) — an unset expiry never
 * blocks the gate/dispense flow (§3.11 invariant 4). The boundary at `expiryDate === asOf` is
 * treated as already expired, matching the identical boundary convention already used by
 * Module 04's `TransactingEligibilityPolicy`/`ExpiryDate` VO.
 */
export class ValidityPeriod {
  private constructor(
    readonly issueDate: Date | null,
    readonly expiryDate: Date | null,
  ) {}

  static of(props: ValidityPeriodProps): ValidityPeriod {
    const issueDate = props.issueDate ?? null;
    const expiryDate = props.expiryDate ?? null;
    if (issueDate && expiryDate && expiryDate.getTime() < issueDate.getTime()) {
      throw PrescriptionMatchingErrors.validation('expiryDate must be on or after issueDate.', {
        field: 'expiryDate',
      });
    }
    return new ValidityPeriod(issueDate, expiryDate);
  }

  isExpired(asOf: Date = new Date()): boolean {
    if (!this.expiryDate) {
      return false;
    }
    return this.expiryDate.getTime() <= asOf.getTime();
  }
}
