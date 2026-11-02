import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  availableActions,
  catalogErrorMessage,
  catalogReviewQuery,
  createAdminCatalogService,
  isSearchFilter,
  isValidCatalogRejectReason,
  productName,
} from './adminCatalog.service';
import type { SessionRequest } from './auth.service';

describe('catalogReviewQuery', () => {
  it('sends only the filters that are set; "all" is no filter', () => {
    expect(catalogReviewQuery({})).toBe('');
    expect(catalogReviewQuery({ status: 'all', type: 'all', q: '  ' })).toBe('');
    expect(catalogReviewQuery({ status: 'PENDING_REVIEW', type: 'MEDICINE', q: ' amoxi ', page: 1, size: 25 })).toBe(
      '?status=PENDING_REVIEW&type=MEDICINE&q=amoxi&page=1&size=25',
    );
  });
});

describe('availableActions', () => {
  it('offers a decision only when the status matches and the server allows the target', () => {
    expect(availableActions({ status: 'PENDING_REVIEW', allowedTransitions: ['ACTIVE', 'REJECTED'] }).sort()).toEqual(['approve', 'reject']);
    expect(availableActions({ status: 'PENDING_REVIEW', allowedTransitions: ['REJECTED'] })).toEqual(['reject']);
    expect(availableActions({ status: 'DRAFT', allowedTransitions: ['PENDING_REVIEW'] })).toEqual(['submit']);
    expect(availableActions({ status: 'REJECTED', allowedTransitions: ['PENDING_REVIEW'] })).toEqual(['resubmit']);
    expect(availableActions({ status: 'ACTIVE', allowedTransitions: ['DEPRECATED', 'DELISTED'] })).toEqual([]);
    expect(availableActions({ status: 'DRAFT', allowedTransitions: [] })).toEqual([]);
  });
});

describe('input rules and names', () => {
  it('search: 1–100 characters; reject reason: 3–300', () => {
    expect(isSearchFilter('a')).toBe(true);
    expect(isSearchFilter('x'.repeat(101))).toBe(false);
    expect(isValidCatalogRejectReason('no')).toBe(false);
    expect(isValidCatalogRejectReason('Duplicate of an active product')).toBe(true);
    expect(isValidCatalogRejectReason('x'.repeat(301))).toBe(false);
  });

  it('names a product by brand, generic, English, then Amharic name', () => {
    expect(productName({ brandName: 'Amoxil', genericName: 'Amoxicillin', nameEn: null, nameAm: null })).toBe('Amoxil');
    expect(productName({ brandName: null, genericName: 'Amoxicillin', nameEn: 'X', nameAm: null })).toBe('Amoxicillin');
    expect(productName({ brandName: null, genericName: null, nameEn: null, nameAm: 'አሞክሲሲሊን' })).toBe('አሞክሲሲሊን');
    expect(productName({ brandName: null, genericName: null, nameEn: null, nameAm: null })).toBe('Unnamed product');
  });
});

describe('adminCatalogService', () => {
  it('reads the queue, summary and history, and posts each decision to its own route', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminCatalogService(request as unknown as SessionRequest);

    await svc.list({ status: 'PENDING_REVIEW', page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review?status=PENDING_REVIEW&page=1&size=25', { method: 'GET' });
    await svc.summary();
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review/summary', { method: 'GET' });
    await svc.history('p/1');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review/p%2F1/history', { method: 'GET' });
    await svc.approve('p1');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review/p1/approve', { method: 'POST' });
    await svc.submit('p1');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review/p1/submit', { method: 'POST' });
    await svc.resubmit('p1');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review/p1/resubmit', { method: 'POST' });
    await svc.reject('p1', '  Duplicate  ');
    expect(request).toHaveBeenLastCalledWith('/admin/catalog/review/p1/reject', { method: 'POST', body: { reason: 'Duplicate' } });
  });
});

describe('catalogErrorMessage', () => {
  it('maps permission and missing-product errors and passes the rest through', () => {
    expect(catalogErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'f')).toMatch(/not allowed/);
    expect(catalogErrorMessage(new ApiError(404, 'NOT_FOUND', 'x'), 'f')).toMatch(/no longer exists/);
    expect(catalogErrorMessage(new ApiError(409, 'INVALID_TRANSITION', 'Not pending'), 'f')).toBe('Not pending');
    expect(catalogErrorMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});
