export interface SellableBatchInput {
  quantity: number;
  expiryDate: Date;
}

/**
 * BRULE-15 (module-04 §3.9). Pure. `sellable = Σ(batch.quantity where expiryDate > now) −
 * reserved`, floored at 0 — expired batches contribute zero, and `reserved` exceeding on-hand
 * (a defensive edge case, never expected in steady state) never produces a negative result.
 */
export const SellableStockCalculator = {
  computeSellable(batches: SellableBatchInput[], reserved: number, now: Date = new Date()): number {
    const onHandUnexpired = batches
      .filter((b) => b.expiryDate.getTime() > now.getTime())
      .reduce((sum, b) => sum + b.quantity, 0);
    return Math.max(0, onHandUnexpired - reserved);
  },
};
