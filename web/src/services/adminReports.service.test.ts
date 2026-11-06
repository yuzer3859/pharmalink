import { describe, expect, it, vi } from 'vitest';
import { createAdminReportsService, isPending, rangeProblem, REPORT_LABELS } from './adminReports.service';
import type { SessionRequest } from './auth.service';

describe('adminReportsService (Work 90)', () => {
  it('requests with an Idempotency-Key, lists, and asks for a download link', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminReportsService(request as unknown as SessionRequest, () => 'key-12345');
    await svc.request({ type: 'PAYMENTS', from: '2026-11-01', to: '2026-11-06' });
    expect(request).toHaveBeenLastCalledWith('/admin/reports', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-12345' },
      body: { type: 'PAYMENTS', from: '2026-11-01', to: '2026-11-06' },
    });
    await svc.list(2, 10);
    expect(request).toHaveBeenLastCalledWith('/admin/reports?page=2&size=10', { method: 'GET' });
    await svc.download('r 1');
    expect(request).toHaveBeenLastCalledWith('/admin/reports/r%201/download', { method: 'POST', body: {} });
    await svc.types();
    expect(request).toHaveBeenLastCalledWith('/admin/reports/types', { method: 'GET' });
  });

  it('checks a range as the server does', () => {
    expect(rangeProblem('2026-11-01', '2026-11-06')).toBeNull();
    expect(rangeProblem('', '2026-11-06')).toBe('Choose both dates.');
    expect(rangeProblem('2026-11-07', '2026-11-06')).toBe('The start must not be after the end.');
    expect(rangeProblem('2025-01-01', '2026-01-01')).toBeNull();
    expect(rangeProblem('2025-01-01', '2026-01-02')).toBe('A report covers at most 366 days.');
  });

  it('polls only while a report is queued or running, and labels every type', () => {
    expect(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED'].map((status) => isPending({ status: status as never }))).toEqual([true, true, false, false, false]);
    expect(Object.keys(REPORT_LABELS).sort()).toEqual(['ANALYTICS_DAILY', 'AUDIT', 'ORDERS', 'PAYMENTS', 'REFUNDS']);
  });
});
