/** Wraps a Date and exposes expiry checks (module-04 §3.8). */
export class ExpiryDate {
  private constructor(readonly value: Date) {}

  static of(value: Date): ExpiryDate {
    return new ExpiryDate(value);
  }

  isExpired(asOf: Date = new Date()): boolean {
    return this.value.getTime() <= asOf.getTime();
  }
}
