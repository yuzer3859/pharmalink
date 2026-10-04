import { PaymentErrors } from '../errors';

/**
 * `SettlementPeriod` — the window a settlement statement covers.
 *
 * ## Half-open, `[start, end)`
 *
 * The end instant belongs to the *next* period, never this one. That is the only boundary rule
 * that makes consecutive periods both gapless and non-overlapping: with an inclusive end, a
 * posting written at exactly midnight would fall into two statements and be paid twice, and
 * shifting the end back by a millisecond to avoid that would drop any posting landing inside the
 * gap. A payable that is settled twice, or never, is the failure this class exists to prevent.
 *
 * ## No calendar semantics
 *
 * Deliberately just two instants. The design's §9.6 speaks of a `{ period }` and §11.5 of a
 * settlement run, but nothing anywhere defines whether a period is a calendar month, a week, or a
 * rolling window, nor which timezone its boundaries are in — and in a country on UTC+3 that
 * choice moves real money between statements. Inventing one here would bake an unasked-for
 * business rule into the ledger's read path, so the caller supplies both instants and the
 * scheduler that eventually runs settlements owns the calendar question.
 *
 * ## Identity
 *
 * `(pharmacyId, start, end, currency)` is the settlement's idempotency key — see
 * `ISettlementRepository`. This class only guarantees the period half of it is well-formed and
 * compared by value, never by object identity.
 */
export class SettlementPeriod {
  private constructor(
    readonly start: Date,
    readonly end: Date,
  ) {}

  static of(start: Date, end: Date): SettlementPeriod {
    assertValidDate(start, 'periodStart');
    assertValidDate(end, 'periodEnd');
    if (start.getTime() >= end.getTime()) {
      // Equal is rejected as well as inverted: an empty window would produce a statement that
      // reads as "nothing was owed this period" when in truth nothing was ever looked at.
      throw PaymentErrors.validation('periodStart must be strictly before periodEnd.', {
        field: 'periodStart',
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
      });
    }
    return new SettlementPeriod(new Date(start.getTime()), new Date(end.getTime()));
  }

  /** `[start, end)` — the half-open test every settlement read uses. */
  contains(instant: Date): boolean {
    const t = instant.getTime();
    return t >= this.start.getTime() && t < this.end.getTime();
  }

  equals(other: SettlementPeriod): boolean {
    return (
      this.start.getTime() === other.start.getTime() &&
      this.end.getTime() === other.end.getTime()
    );
  }

  toString(): string {
    return `${this.start.toISOString()}/${this.end.toISOString()}`;
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw PaymentErrors.validation(`${field} must be a valid date.`, { field });
  }
}
