import { PharmacyInventoryErrors } from '../errors';

/** `{ amountMinor, currency }` (module-04 §3.8), mirroring ADR-005. Slice 1: `ETB` only. */
export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: string,
  ) {}

  static of(amountMinor: number, currency: string = 'ETB'): Money {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw PharmacyInventoryErrors.validation('price must be a positive integer (minor units).', {
        field: 'price',
      });
    }
    if (currency !== 'ETB') {
      throw PharmacyInventoryErrors.validation('Only ETB is supported in Slice 1.', {
        field: 'currency',
      });
    }
    return new Money(amountMinor, currency);
  }
}
