import { authService, type SessionRequest } from './auth.service';
import { toQuery } from './adminFinance.service';

export type AnomalyRule = 'OFF_HOURS' | 'BURST' | 'SENSITIVE_VOLUME' | 'SELF_TARGETED' | 'MANY_IPS';

export interface AnomalyFlag {
  rule: AnomalyRule;
  count: number;
  firstAt: string;
  exampleIds: string[];
}

export interface StaffActivity {
  userId: string;
  email: string | null;
  phone: string | null;
  status: string;
  roles: string[];
  total: number;
  byAction: Array<{ action: string; count: number }>;
  firstAt: string | null;
  lastAt: string | null;
  distinctIps: number;
  flags: AnomalyFlag[];
}

export interface ActivityReport {
  from: string;
  to: string;
  truncated: boolean;
  staff: StaffActivity[];
}

export interface ActivityEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ip: string | null;
  createdAt: string;
}

/** What each rule means, in the words the page shows (backend/docs/admin-activity.md). */
export const RULE_LABELS: Record<AnomalyRule, { label: string; help: string }> = {
  OFF_HOURS: { label: 'Off-hours', help: 'Actions between 22:00 and 06:00 East Africa Time.' },
  BURST: { label: 'Burst', help: '30 or more actions within 10 minutes.' },
  SENSITIVE_VOLUME: { label: 'Sensitive volume', help: '10 or more sensitive actions (suspensions, role changes, refunds, payouts, configuration…) within 24 hours.' },
  SELF_TARGETED: { label: 'Own account', help: 'A sensitive action on their own account.' },
  MANY_IPS: { label: 'Many IPs', help: '5 or more distinct IP addresses in the window.' },
};

/** The window choices, in hours; the server allows at most 31 days. */
export const WINDOWS = [
  { hours: 24, label: '24 hours' },
  { hours: 7 * 24, label: '7 days' },
  { hours: 31 * 24, label: '31 days' },
] as const;

/** `[from, to)` ending at `now`. */
export const windowFor = (hours: number, now = new Date()) => ({
  from: new Date(now.getTime() - hours * 3_600_000).toISOString(),
  to: now.toISOString(),
});

export function createAdminActivityService(request: SessionRequest) {
  return {
    /** `GET /admin/admins/activity` (`staff:monitor:any`, Super Admin). The read is audited. */
    report(range: { from?: string; to?: string } = {}): Promise<ActivityReport> {
      return request<ActivityReport>(`/admin/admins/activity${toQuery(range)}`, { method: 'GET' });
    },
    /** `GET /admin/admins/activity/{userId}`: that staff member's audit entries, newest first. */
    entries(userId: string, range: { from?: string; to?: string; page?: number; size?: number } = {}) {
      return request<{ items: ActivityEntry[]; total: number; page: number; size: number }>(
        `/admin/admins/activity/${encodeURIComponent(userId)}${toQuery(range)}`,
        { method: 'GET' },
      );
    },
  };
}

export const adminActivityService = createAdminActivityService(authService.request);
