import { describe, expect, it, vi } from 'vitest';
import type { SessionRequest } from './auth.service';
import {
  adjustmentProblem,
  batchProblem,
  createPharmacyInventoryService,
  listingQuery,
  newListingProblem,
  productLabel,
  stockLevel,
  toSantim,
} from './pharmacyInventory.service';

const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;

describe('stockLevel', () => {
  it('reads sellable stock, and a disabled listing as disabled', () => {
    expect(stockLevel({ sellable: 0, isEnabled: true })).toBe('out_of_stock');
    expect(stockLevel({ sellable: 9, isEnabled: true })).toBe('low_stock');
    expect(stockLevel({ sellable: 10, isEnabled: true })).toBe('in_stock');
    expect(stockLevel({ sellable: 50, isEnabled: false })).toBe('disabled');
  });
});

describe('toSantim', () => {
  it('converts birr to whole santim and refuses non-positive amounts', () => {
    expect(toSantim(12)).toBe(1200);
    expect(toSantim(45.5)).toBe(4550);
    expect(toSantim(0.015)).toBe(2);
    expect(toSantim(0)).toBeNull();
    expect(toSantim(-1)).toBeNull();
    expect(toSantim(Number.NaN)).toBeNull();
  });
});

describe('form rules (the server’s)', () => {
  it('a batch needs a number, a whole quantity of at least 1, and a future expiry', () => {
    expect(batchProblem({ batchNumber: 'B-1', quantity: 10, expiryDate: nextYear })).toBeNull();
    expect(batchProblem({ batchNumber: ' ', quantity: 10, expiryDate: nextYear })).not.toBeNull();
    expect(batchProblem({ batchNumber: 'x'.repeat(61), quantity: 10, expiryDate: nextYear })).not.toBeNull();
    expect(batchProblem({ batchNumber: 'B-1', quantity: 0, expiryDate: nextYear })).not.toBeNull();
    expect(batchProblem({ batchNumber: 'B-1', quantity: 2.5, expiryDate: nextYear })).not.toBeNull();
    expect(batchProblem({ batchNumber: 'B-1', quantity: 1, expiryDate: '2020-01-01' })).not.toBeNull();
    expect(batchProblem({ batchNumber: 'B-1', quantity: 1, expiryDate: 'soon' })).not.toBeNull();
  });

  it('a new listing needs a product, a branch and a price, then a valid first batch', () => {
    const ok = { catalogProductId: 'p-1', branchId: 'b-1', priceBirr: 12, batchNumber: 'B-1', initialQuantity: 5, expiryDate: nextYear };
    expect(newListingProblem(ok)).toBeNull();
    expect(newListingProblem({ ...ok, catalogProductId: '' })).not.toBeNull();
    expect(newListingProblem({ ...ok, branchId: '' })).not.toBeNull();
    expect(newListingProblem({ ...ok, priceBirr: 0 })).not.toBeNull();
    expect(newListingProblem({ ...ok, initialQuantity: 0 })).not.toBeNull();
  });

  it('an adjustment is a non-zero whole change that does not take a batch below 0, with a 3-300 character reason', () => {
    expect(adjustmentProblem(-2, 'Damaged', 10)).toBeNull();
    expect(adjustmentProblem(5, 'Recount', 0)).toBeNull();
    expect(adjustmentProblem(0, 'Damaged', 10)).not.toBeNull();
    expect(adjustmentProblem(1.5, 'Damaged', 10)).not.toBeNull();
    expect(adjustmentProblem(-11, 'Damaged', 10)).not.toBeNull();
    expect(adjustmentProblem(-1, 'ab', 10)).not.toBeNull();
    expect(adjustmentProblem(-1, 'x'.repeat(301), 10)).not.toBeNull();
  });
});

describe('productLabel', () => {
  it('prefers the English name, then generic, then brand', () => {
    expect(productLabel({ id: '1', nameEn: 'ORS sachet', genericName: 'Oral rehydration salts' })).toBe('ORS sachet');
    expect(productLabel({ id: '1', nameEn: null, genericName: 'Amoxicillin' })).toBe('Amoxicillin');
    expect(productLabel({ id: '1', brandName: 'Amoxil' })).toBe('Amoxil');
  });
});

describe('listingQuery', () => {
  it('sends only what is set, capped at 50', () => {
    expect(listingQuery({})).toBe('');
    expect(listingQuery({ branchId: 'b-1', page: 2, size: 25 })).toBe('?branchId=b-1&page=2&size=25');
    expect(listingQuery({ size: 500 })).toBe('?size=50');
  });
});

describe('pharmacyInventoryService', () => {
  it('reads listings, one listing, its movements, branches and the catalogue', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const s = createPharmacyInventoryService(request as unknown as SessionRequest);

    await s.list({ page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/inventory/listings?page=1&size=25', { method: 'GET' });
    await s.get('l/1');
    expect(request).toHaveBeenLastCalledWith('/inventory/listings/l%2F1', { method: 'GET' });
    await s.movements('l-1');
    expect(request).toHaveBeenLastCalledWith('/inventory/listings/l-1/movements?page=1&size=20', { method: 'GET' });
    await s.branches();
    expect(request).toHaveBeenLastCalledWith('/pharmacy/branches', { method: 'GET' });
    await s.searchProducts(' ors ');
    expect(request).toHaveBeenLastCalledWith('/catalog/products?q=ors&size=10', { method: 'GET' });
  });

  it('sends money in santim and dates as ISO instants', async () => {
    const request = vi.fn().mockResolvedValue({});
    const s = createPharmacyInventoryService(request as unknown as SessionRequest);

    await s.create({ catalogProductId: 'p-1', branchId: 'b-1', priceBirr: 12.5, batchNumber: ' B-1 ', initialQuantity: 20, expiryDate: '2027-06-30', supplier: '  ' });
    expect(request).toHaveBeenLastCalledWith('/inventory/listings', {
      method: 'POST',
      body: { catalogProductId: 'p-1', branchId: 'b-1', price: 1250, batchNumber: 'B-1', initialQuantity: 20, expiryDate: '2027-06-30T00:00:00.000Z' },
    });

    await s.update('l-1', { priceBirr: 13 });
    expect(request).toHaveBeenLastCalledWith('/inventory/listings/l-1', { method: 'PATCH', body: { price: 1300 } });
    await s.update('l-1', { isEnabled: false });
    expect(request).toHaveBeenLastCalledWith('/inventory/listings/l-1', { method: 'PATCH', body: { isEnabled: false } });

    await s.receive('l-1', { batchNumber: 'B-2', quantity: 10, expiryDate: '2027-01-31', supplier: 'Addis Pharma' });
    expect(request).toHaveBeenLastCalledWith('/inventory/listings/l-1/batches', {
      method: 'POST',
      body: { batchNumber: 'B-2', quantity: 10, expiryDate: '2027-01-31T00:00:00.000Z', supplier: 'Addis Pharma' },
    });

    await s.adjust('batch-1', -2, ' Damaged ');
    expect(request).toHaveBeenLastCalledWith('/inventory/batches/batch-1', { method: 'PATCH', body: { quantityDelta: -2, reason: 'Damaged' } });

    await s.remove('l-1');
    expect(request).toHaveBeenLastCalledWith('/inventory/listings/l-1', { method: 'DELETE' });
  });
});
