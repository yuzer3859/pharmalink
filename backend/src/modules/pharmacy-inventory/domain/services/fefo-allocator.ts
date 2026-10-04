import { PharmacyInventoryErrors } from '../errors';

export interface FefoBatchInput {
  id: string;
  quantity: number;
  expiryDate: Date;
}

export interface FefoAllocation {
  batchId: string;
  qty: number;
}

/**
 * BR-PH-07/14 (module-04 §3.9, §8). Pure. Allocates `requestedQty` earliest-expiry-first;
 * throws `INSUFFICIENT_STOCK` if `Σquantity < requestedQty`. Ties on `expiryDate` are broken by
 * the input array's original order (stable sort), so callers control tie-break order (e.g. by
 * pre-sorting batches by `createdAt`/`id` upstream) rather than this function re-deriving one.
 */
export const FefoAllocator = {
  allocate(batches: FefoBatchInput[], requestedQty: number): FefoAllocation[] {
    const total = batches.reduce((sum, b) => sum + b.quantity, 0);
    if (total < requestedQty) {
      throw PharmacyInventoryErrors.insufficientStock(total);
    }

    const sorted = [...batches]
      .map((b, index) => ({ ...b, index }))
      .sort((a, b) => {
        const byExpiry = a.expiryDate.getTime() - b.expiryDate.getTime();
        return byExpiry !== 0 ? byExpiry : a.index - b.index;
      });

    const allocations: FefoAllocation[] = [];
    let remaining = requestedQty;
    for (const batch of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(batch.quantity, remaining);
      if (take > 0) {
        allocations.push({ batchId: batch.id, qty: take });
        remaining -= take;
      }
    }
    return allocations;
  },
};
