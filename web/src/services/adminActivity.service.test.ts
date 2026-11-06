import { describe, expect, it, vi } from 'vitest';
import { createAdminActivityService, RULE_LABELS, WINDOWS, windowFor } from './adminActivity.service';
import type { SessionRequest } from './auth.service';

describe('adminActivityService (Work 88)', () => {
  it('reads the report and one member’s entries with the window', async () => {
    const request = vi.fn().mockResolvedValue({});
    const svc = createAdminActivityService(request as unknown as SessionRequest);
    await svc.report({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' });
    expect(request).toHaveBeenLastCalledWith('/admin/admins/activity?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z', { method: 'GET' });
    await svc.report();
    expect(request).toHaveBeenLastCalledWith('/admin/admins/activity', { method: 'GET' });
    await svc.entries('u-1', { size: 100 });
    expect(request).toHaveBeenLastCalledWith('/admin/admins/activity/u-1?size=100', { method: 'GET' });
  });

  it('builds a window ending now, never longer than the server allows', () => {
    const now = new Date('2026-11-06T12:00:00.000Z');
    expect(windowFor(24, now)).toEqual({ from: '2026-11-05T12:00:00.000Z', to: '2026-11-06T12:00:00.000Z' });
    expect(Math.max(...WINDOWS.map((w) => w.hours))).toBeLessThanOrEqual(31 * 24);
  });

  it('explains every rule the server can raise', () => {
    expect(Object.keys(RULE_LABELS).sort()).toEqual(['BURST', 'MANY_IPS', 'OFF_HOURS', 'SELF_TARGETED', 'SENSITIVE_VOLUME']);
  });
});
