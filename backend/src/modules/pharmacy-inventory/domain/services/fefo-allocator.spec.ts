import { FefoAllocator } from './fefo-allocator';

describe('FefoAllocator', () => {
  it('allocates from the earliest-expiry batch first', () => {
    const batches = [
      { id: 'b-late', quantity: 10, expiryDate: new Date('2026-06-01') },
      { id: 'b-early', quantity: 5, expiryDate: new Date('2026-01-01') },
    ];
    const result = FefoAllocator.allocate(batches, 5);
    expect(result).toEqual([{ batchId: 'b-early', qty: 5 }]);
  });

  it('spans multiple batches earliest-first when one batch is insufficient alone', () => {
    const batches = [
      { id: 'b1', quantity: 3, expiryDate: new Date('2026-01-01') },
      { id: 'b2', quantity: 10, expiryDate: new Date('2026-02-01') },
    ];
    const result = FefoAllocator.allocate(batches, 5);
    expect(result).toEqual([
      { batchId: 'b1', qty: 3 },
      { batchId: 'b2', qty: 2 },
    ]);
  });

  it('throws INSUFFICIENT_STOCK when total quantity is less than requested', () => {
    const batches = [{ id: 'b1', quantity: 2, expiryDate: new Date('2026-01-01') }];
    expect(() => FefoAllocator.allocate(batches, 5)).toThrow();
    try {
      FefoAllocator.allocate(batches, 5);
    } catch (err) {
      expect((err as { code: string }).code).toBe('INSUFFICIENT_STOCK');
      expect((err as { details: { available: number } }).details.available).toBe(2);
    }
  });

  it('breaks ties on shared expiry dates using stable input order', () => {
    const sameExpiry = new Date('2026-01-01');
    const batches = [
      { id: 'first', quantity: 3, expiryDate: sameExpiry },
      { id: 'second', quantity: 3, expiryDate: sameExpiry },
    ];
    const result = FefoAllocator.allocate(batches, 4);
    expect(result).toEqual([
      { batchId: 'first', qty: 3 },
      { batchId: 'second', qty: 1 },
    ]);
  });
});
