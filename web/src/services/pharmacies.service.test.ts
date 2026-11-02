import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import { activationErrorMessage, createPharmaciesService, pharmacyQuery } from './pharmacies.service';
import type { SessionRequest } from './auth.service';

const PHARMACY = {
  pharmacyId: '0b6c1f8e-2d3a-4b5c-8d9e-0f1a2b3c4d5e',
  transactingStatus: 'PENDING',
  licenseStatus: 'VALID',
  licenseExpiresAt: '2027-11-02T00:00:00.000Z',
  eligible: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  branches: { total: 2, active: 1 },
  listings: { total: 4, enabled: 3, disabled: 1, inStock: 3, outOfStock: 1, customerPurchasable: 0, customerUnpurchasable: 4 },
};

const fakeRequest = (value: unknown) => vi.fn().mockResolvedValue(value);

describe('pharmacyQuery', () => {
  it('sends only the filters that are set; "all" is no filter', () => {
    expect(pharmacyQuery({})).toBe('');
    expect(pharmacyQuery({ transactingStatus: 'all' })).toBe('');
    expect(pharmacyQuery({ transactingStatus: 'PENDING', eligible: false, page: 2, size: 25 })).toBe(
      '?transactingStatus=PENDING&eligible=false&page=2&size=25',
    );
    expect(pharmacyQuery({ eligible: true, hasPurchasableInventory: true })).toBe('?eligible=true&hasPurchasableInventory=true');
  });
});

describe('pharmaciesService', () => {
  it('lists from GET /admin/operations/pharmacies', async () => {
    const page = { items: [PHARMACY], total: 1, page: 1, size: 25 };
    const request = fakeRequest(page);
    const service = createPharmaciesService(request as unknown as SessionRequest);

    await expect(service.list({ transactingStatus: 'PENDING', page: 1, size: 25 })).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith('/admin/operations/pharmacies?transactingStatus=PENDING&page=1&size=25', { method: 'GET' });
  });

  it('reads one pharmacy by id, encoded', async () => {
    const request = fakeRequest(PHARMACY);
    await createPharmaciesService(request as unknown as SessionRequest).get('a/b');
    expect(request).toHaveBeenCalledWith('/admin/operations/pharmacies/a%2Fb', { method: 'GET' });
  });

  it('activates through POST /pharmacy/activate with the pharmacy id only', async () => {
    const request = fakeRequest({ pharmacyId: PHARMACY.pharmacyId, transactingStatus: 'ACTIVE' });
    await createPharmaciesService(request as unknown as SessionRequest).activate(PHARMACY.pharmacyId);
    expect(request).toHaveBeenCalledWith('/pharmacy/activate', { method: 'POST', body: { pharmacyId: PHARMACY.pharmacyId } });
  });

  it('offers no suspend or status edit: the backend has no such endpoint', () => {
    const service = createPharmaciesService(vi.fn() as unknown as SessionRequest);
    expect(Object.keys(service).sort()).toEqual(['activate', 'get', 'list']);
  });
});

describe('activationErrorMessage', () => {
  const refused = (reason: string) => new ApiError(403, 'PHARMACY_NOT_ELIGIBLE', 'refused', { reason });

  it('explains each server refusal', () => {
    expect(activationErrorMessage(refused('ORGANIZATION_NOT_ACTIVE'))).toMatch(/organisation is not active/);
    expect(activationErrorMessage(refused('LICENSE_MISSING'))).toMatch(/no approved, current licence/);
    expect(activationErrorMessage(refused('LICENSE_NOT_APPROVED'))).toMatch(/no approved, current licence/);
    expect(activationErrorMessage(refused('ORGANIZATION_NOT_PHARMACY'))).toMatch(/not a pharmacy/);
    expect(activationErrorMessage(refused('SOMETHING_NEW'))).toBe('Not activated: refused');
    expect(activationErrorMessage(new ApiError(403, 'LICENSE_EXPIRED', 'expired'))).toMatch(/licence has expired/);
  });

  it('separates a missing permission from a refusal, and copes with non-API errors', () => {
    expect(activationErrorMessage(new ApiError(403, 'FORBIDDEN', 'no'))).toMatch(/not allowed to activate/);
    expect(activationErrorMessage(new ApiError(404, 'NOT_FOUND', 'Pharmacy not found.'))).toBe('Pharmacy not found.');
    expect(activationErrorMessage(new Error('boom'))).toBe('The pharmacy could not be activated.');
  });
});
