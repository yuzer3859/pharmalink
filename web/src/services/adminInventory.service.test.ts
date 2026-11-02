import { describe, expect, it, vi } from 'vitest';
import { adminListingQuery, createAdminInventoryService, isUuidFilter } from './adminInventory.service';
import type { SessionRequest } from './auth.service';

const PHARMACY_ID = '0b6c1f8e-2d3a-4b5c-8d9e-0f1a2b3c4d5e';

describe('adminListingQuery', () => {
  it('sends only the filters that are set, booleans as true/false', () => {
    expect(adminListingQuery({})).toBe('');
    expect(adminListingQuery({ pharmacyId: '  ' })).toBe('');
    expect(adminListingQuery({ pharmacyId: ` ${PHARMACY_ID} `, isEnabled: false, customerPurchasable: true, page: 2, size: 50 })).toBe(
      `?pharmacyId=${PHARMACY_ID}&isEnabled=false&customerPurchasable=true&page=2&size=50`,
    );
    expect(adminListingQuery({ hasStoredSellableStock: true })).toBe('?hasStoredSellableStock=true');
  });
});

describe('isUuidFilter', () => {
  it('accepts a UUID only, as the API does', () => {
    expect(isUuidFilter(PHARMACY_ID)).toBe(true);
    expect(isUuidFilter(` ${PHARMACY_ID.toUpperCase()} `)).toBe(true);
    expect(isUuidFilter('0b6c1f8e')).toBe(false);
  });
});

describe('adminInventoryService', () => {
  it('lists from GET /admin/operations/inventory/listings and reads one listing by id', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, size: 25 });
    const service = createAdminInventoryService(request as unknown as SessionRequest);

    await service.list({ isEnabled: true, page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/operations/inventory/listings?isEnabled=true&page=1&size=25', { method: 'GET' });

    await service.get('l/1');
    expect(request).toHaveBeenLastCalledWith('/admin/operations/inventory/listings/l%2F1', { method: 'GET' });
  });

  it('is read-only', () => {
    const service = createAdminInventoryService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['get', 'list']);
  });
});
