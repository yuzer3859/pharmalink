import { PharmacyInventoryErrors } from '../errors';

/** 1-60 char trimmed string wrapper (module-04 §3.8). */
export class BatchNumber {
  private constructor(readonly value: string) {}

  static of(raw: string): BatchNumber {
    const trimmed = raw.trim();
    if (trimmed.length < 1 || trimmed.length > 60) {
      throw PharmacyInventoryErrors.validation('batchNumber must be 1-60 characters.', {
        field: 'batchNumber',
      });
    }
    return new BatchNumber(trimmed);
  }
}
