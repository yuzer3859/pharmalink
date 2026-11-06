import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './apiClient';
import {
  approvalBody,
  approvalProblem,
  createAdminVerificationsService,
  endOfDayIso,
  formatAge,
  isValidRejectReason,
  previewErrorMessage,
  verificationErrorMessage,
  verificationQuery,
} from './adminVerifications.service';
import type { SessionRequest } from './auth.service';

const NOW = new Date('2026-11-02T12:00:00.000Z');

describe('verificationQuery', () => {
  it('sends only the filters that are set; "all" is no filter', () => {
    expect(verificationQuery({})).toBe('');
    expect(verificationQuery({ status: 'all', type: 'all' })).toBe('');
    expect(verificationQuery({ status: 'PENDING', type: 'PHARMACY_LICENSE', page: 1, size: 25 })).toBe(
      '?status=PENDING&type=PHARMACY_LICENSE&page=1&size=25',
    );
  });
});

describe('approvalProblem (Work 67 rules, checked before sending)', () => {
  it('a pharmacy licence needs a licence number and a future expiry', () => {
    expect(approvalProblem({ type: 'PHARMACY_LICENSE' }, NOW)).toMatch(/licence number/);
    expect(approvalProblem({ type: 'PHARMACY_LICENSE', licenseNumber: '   ' }, NOW)).toMatch(/licence number/);
    expect(approvalProblem({ type: 'PHARMACY_LICENSE', licenseNumber: 'AA-1' }, NOW)).toMatch(/expiry date/);
    expect(approvalProblem({ type: 'PHARMACY_LICENSE', licenseNumber: 'x'.repeat(65), expiresOn: '2027-01-01' }, NOW)).toMatch(/at most 64/);
    expect(approvalProblem({ type: 'PHARMACY_LICENSE', licenseNumber: 'AA-1', expiresOn: '2026-11-01' }, NOW)).toMatch(/later than today/);
    expect(approvalProblem({ type: 'PHARMACY_LICENSE', licenseNumber: 'AA-1', expiresOn: '2027-11-02' }, NOW)).toBeNull();
  });

  it('other types need nothing, but a given expiry must be in the future and a note bounded', () => {
    expect(approvalProblem({ type: 'FAYDA' }, NOW)).toBeNull();
    expect(approvalProblem({ type: 'DOCTOR_LICENSE', expiresOn: '2026-01-01' }, NOW)).toMatch(/later than today/);
    expect(approvalProblem({ type: 'DRIVER_DOCS', reason: 'x'.repeat(501) }, NOW)).toMatch(/at most 500/);
  });

  it('today counts as later than now until the end of the day', () => {
    expect(approvalProblem({ type: 'FAYDA', expiresOn: '2026-11-02' }, NOW)).toBeNull();
    expect(endOfDayIso('2026-11-02')).toBe('2026-11-02T23:59:59.000Z');
  });
});

describe('approvalBody', () => {
  it('sends only the applicable fields, trimmed, and never a reviewer', () => {
    expect(approvalBody({ type: 'PHARMACY_LICENSE', licenseNumber: ' AA-1 ', expiresOn: '2027-11-02', reason: '  ok ' })).toEqual({
      licenseNumber: 'AA-1',
      expiresAt: '2027-11-02T23:59:59.000Z',
      reason: 'ok',
    });
    expect(approvalBody({ type: 'FAYDA', licenseNumber: 'ignored', reason: '   ' })).toEqual({});
  });
});

describe('rejection, age and errors', () => {
  it('reject reason: 3–500 characters', () => {
    expect(isValidRejectReason('no')).toBe(false);
    expect(isValidRejectReason('Blurred document')).toBe(true);
    expect(isValidRejectReason('x'.repeat(501))).toBe(false);
  });

  it('formats waiting time', () => {
    expect(formatAge(59)).toBe('0m');
    expect(formatAge(45 * 60)).toBe('45m');
    expect(formatAge(5 * 3600)).toBe('5h');
    expect(formatAge(3 * 86_400 + 10)).toBe('3d');
  });

  it('adds the server reason to its message', () => {
    expect(
      verificationErrorMessage(new ApiError(422, 'BUSINESS_RULE_VIOLATION', 'Licence organisation mismatch', { reason: 'OWNER_MISMATCH' }), 'f'),
    ).toBe('Licence organisation mismatch (owner mismatch)');
    expect(verificationErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'), 'f')).toMatch(/not allowed/);
    expect(verificationErrorMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});

describe('adminVerificationsService', () => {
  it('lists, reads, approves and rejects at the right paths', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminVerificationsService(request as unknown as SessionRequest);

    await svc.list({ status: 'PENDING', page: 1, size: 25 });
    expect(request).toHaveBeenLastCalledWith('/admin/verifications?status=PENDING&page=1&size=25', { method: 'GET' });
    await svc.get('r/1');
    expect(request).toHaveBeenLastCalledWith('/admin/verifications/r%2F1', { method: 'GET' });
    await svc.approve('r1', { type: 'PHARMACY_LICENSE', licenseNumber: 'AA-1', expiresOn: '2027-11-02' });
    expect(request).toHaveBeenLastCalledWith('/admin/verifications/r1/approve', {
      method: 'POST',
      body: { licenseNumber: 'AA-1', expiresAt: '2027-11-02T23:59:59.000Z' },
    });
    await svc.reject('r1', '  Blurred document ');
    expect(request).toHaveBeenLastCalledWith('/admin/verifications/r1/reject', { method: 'POST', body: { reason: 'Blurred document' } });
  });
});

describe('document preview (Work 89)', () => {
  it('asks for a signed link to one document by index', async () => {
    const request = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:9100/x', kind: 'DRIVING_LICENSE', contentType: 'application/pdf', expiresAt: '' });
    const svc = createAdminVerificationsService(request as never);
    await svc.previewDocument('req 1', 2);
    expect(request).toHaveBeenCalledWith('/admin/verifications/req%201/documents/2/preview', { method: 'POST', body: {} });
  });

  it('explains why a preview failed', () => {
    expect(previewErrorMessage(new ApiError(409, 'DOCUMENT_NOT_STORED', 'x'))).toBe('There is no stored file for this document.');
    expect(previewErrorMessage(new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'x'))).toBe('Document storage is not available right now.');
    expect(previewErrorMessage(new ApiError(403, 'FORBIDDEN', 'x'))).toBe('Your account is not allowed to do this.');
    expect(previewErrorMessage(new Error('boom'))).toBe('The preview could not be opened.');
  });
});
