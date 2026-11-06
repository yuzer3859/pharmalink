import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AUDIT_READ_PORT, AuditActivityView, AuditPage, IAuditReadPort } from '../../../../shared/audit/audit-read.port';
import {
  IDENTITY_STAFF_READ_PORT,
  IIdentityStaffReadPort,
  StaffMemberView,
} from '../../../identity/application/ports/inbound/identity-staff-read.port';
import { AdminErrors } from '../../domain/errors';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 31;
/** The most entries one read considers; beyond it the response says `truncated`. */
export const ACTIVITY_READ_LIMIT = 20_000;
/** East Africa Time, UTC+3 all year. */
export const EAT_OFFSET_HOURS = 3;

export const ANOMALY_THRESHOLDS = {
  /** Off-hours: from 22:00 to 06:00 EAT. */
  offHoursStart: 22,
  offHoursEnd: 6,
  burstCount: 30,
  burstWindowMs: 10 * 60 * 1000,
  sensitiveCount: 10,
  sensitiveWindowMs: DAY_MS,
  manyIps: 5,
} as const;

/** Actions that change accounts, money, authority or configuration (backend/docs/admin-activity.md). */
export const SENSITIVE_ADMIN_ACTIONS: readonly string[] = [
  'identity.account.suspended',
  'identity.account.reactivated',
  'identity.account.deactivated',
  'rbac.user_role.assigned',
  'rbac.user_role.revoked',
  'rbac.role_permissions.replaced',
  'identity.verification.approved',
  'identity.verification.rejected',
  'identity.platform.super_admin_bootstrapped',
  'CONFIG_CHANGED',
  'FEATURE_FLAG_TOGGLED',
  'PAYMENT_REFUND_REQUESTED',
  'PAYMENT_REFUNDED',
  'SETTLEMENT_APPROVED',
  'SETTLEMENT_PAID',
  'PAYOUT_INITIATED',
  'PAYOUT_BENEFICIARY_VERIFIED',
  'IMPERSONATION_AUTHORIZED',
  'IMPERSONATION_STARTED',
  'DISPUTE_RESOLVED',
];
const SENSITIVE = new Set(SENSITIVE_ADMIN_ACTIONS);

export type AnomalyRule = 'OFF_HOURS' | 'BURST' | 'SENSITIVE_VOLUME' | 'SELF_TARGETED' | 'MANY_IPS';

export interface AnomalyFlag {
  rule: AnomalyRule;
  count: number;
  firstAt: Date;
  /** Up to five audit entry ids, to open in the audit explorer. */
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
  firstAt: Date | null;
  lastAt: Date | null;
  distinctIps: number;
  flags: AnomalyFlag[];
}

export interface ActivityReport {
  from: Date;
  to: Date;
  truncated: boolean;
  staff: StaffActivity[];
}

type Entry = Pick<AuditActivityView, 'id' | 'action' | 'resourceType' | 'resourceId' | 'ip' | 'createdAt'> & { actorUserId: string };

/** The hour (0–23) in East Africa Time. */
export const eatHour = (at: Date) => (at.getUTCHours() + EAT_OFFSET_HOURS) % 24;

const isOffHours = (at: Date) => {
  const h = eatHour(at);
  return h >= ANOMALY_THRESHOLDS.offHoursStart || h < ANOMALY_THRESHOLDS.offHoursEnd;
};

const flagOf = (rule: AnomalyRule, hits: Entry[], count = hits.length): AnomalyFlag => ({
  rule,
  count,
  firstAt: hits[0].createdAt,
  exampleIds: hits.slice(0, 5).map((e) => e.id),
});

/**
 * The densest run of `entries` (oldest first) within `windowMs`: the entries of the first window
 * that holds at least `threshold`, extended to its largest size. `null` when none reaches it.
 */
function densest(entries: Entry[], windowMs: number, threshold: number): Entry[] | null {
  let best: Entry[] | null = null;
  let start = 0;
  for (let end = 0; end < entries.length; end++) {
    while (entries[end].createdAt.getTime() - entries[start].createdAt.getTime() > windowMs) start++;
    const size = end - start + 1;
    if (size >= threshold && (!best || size > best.length)) best = entries.slice(start, end + 1);
  }
  return best;
}

/** The anomaly rules over one actor's entries, oldest first. Pure; no clock, no I/O. */
export function detectAnomalies(actorUserId: string, entries: Entry[]): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  const t = ANOMALY_THRESHOLDS;

  const offHours = entries.filter((e) => isOffHours(e.createdAt));
  if (offHours.length > 0) flags.push(flagOf('OFF_HOURS', offHours));

  const burst = densest(entries, t.burstWindowMs, t.burstCount);
  if (burst) flags.push(flagOf('BURST', burst));

  const sensitive = densest(entries.filter((e) => SENSITIVE.has(e.action)), t.sensitiveWindowMs, t.sensitiveCount);
  if (sensitive) flags.push(flagOf('SENSITIVE_VOLUME', sensitive));

  const self = entries.filter((e) => SENSITIVE.has(e.action) && e.resourceType.toLowerCase() === 'user' && e.resourceId === actorUserId);
  if (self.length > 0) flags.push(flagOf('SELF_TARGETED', self));

  const ips = new Map<string, Entry>();
  for (const e of entries) if (e.ip && !ips.has(e.ip)) ips.set(e.ip, e);
  if (ips.size >= t.manyIps) flags.push(flagOf('MANY_IPS', [...ips.values()], ips.size));

  return flags;
}

export function summarize(member: StaffMemberView, entries: Entry[]): StaffActivity {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  return {
    userId: member.userId,
    email: member.email,
    phone: member.phone,
    status: member.status,
    roles: member.roles,
    total: entries.length,
    byAction: [...counts]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    firstAt: entries[0]?.createdAt ?? null,
    lastAt: entries[entries.length - 1]?.createdAt ?? null,
    distinctIps: new Set(entries.map((e) => e.ip).filter(Boolean)).size,
    flags: detectAnomalies(member.userId, entries),
  };
}

/**
 * Admin activity and anomaly monitoring (Work 88, module-16 F-AD-27, §9.7;
 * backend/docs/admin-activity.md). Staff come from Module 01, entries from the shared audit read
 * port; Admin stores nothing. Every read is itself audited (`ADMIN_ACTIVITY_VIEWED`).
 */
@Injectable()
export class AdminActivityService {
  constructor(
    @Inject(IDENTITY_STAFF_READ_PORT) private readonly staff: IIdentityStaffReadPort,
    @Inject(AUDIT_READ_PORT) private readonly auditRead: IAuditReadPort,
    private readonly audit: AuditService,
  ) {}

  async report(input: { from?: string; to?: string }, viewer: { userId: string; ip?: string | null }, now = new Date()): Promise<ActivityReport> {
    const { from, to } = window(input, now);
    const members = await this.staff.listStaff();
    const page = await this.auditRead.activityOf(members.map((m) => m.userId), from, to, ACTIVITY_READ_LIMIT);
    const byActor = new Map<string, Entry[]>();
    for (const e of page.items) {
      const list = byActor.get(e.actorUserId) ?? [];
      list.push(e);
      byActor.set(e.actorUserId, list);
    }
    const staff = members
      .map((m) => summarize(m, byActor.get(m.userId) ?? []))
      .sort((a, b) => b.flags.length - a.flags.length || b.total - a.total || a.userId.localeCompare(b.userId));
    await this.audit.record({
      actorUserId: viewer.userId,
      action: 'ADMIN_ACTIVITY_VIEWED',
      resourceType: 'AdminActivity',
      resourceId: null,
      context: { from: from.toISOString(), to: to.toISOString(), flagged: staff.filter((s) => s.flags.length > 0).length },
      ip: viewer.ip ?? null,
    });
    return { from, to, truncated: page.truncated, staff };
  }

  /** One staff member's entries, newest first. `NOT_FOUND` for anyone who is not staff. */
  async entriesOf(
    userId: string,
    input: { from?: string; to?: string; page: number; size: number },
    viewer: { userId: string; ip?: string | null },
    now = new Date(),
  ): Promise<AuditPage> {
    const { from, to } = window(input, now);
    const members = await this.staff.listStaff();
    if (!members.some((m) => m.userId === userId)) throw AdminErrors.staffMemberNotFound();
    const page = await this.auditRead.search({ actorUserId: userId, from, to }, input.page, input.size);
    await this.audit.record({
      actorUserId: viewer.userId,
      action: 'ADMIN_ACTIVITY_VIEWED',
      resourceType: 'AdminActivity',
      resourceId: userId,
      context: { from: from.toISOString(), to: to.toISOString() },
      ip: viewer.ip ?? null,
    });
    return page;
  }
}

/** [`from`, `to`) from ISO timestamps; defaults to the 7 days ending now; at most 31 days. */
export function window(input: { from?: string; to?: string }, now: Date): { from: Date; to: Date } {
  const to = input.to ? parse(input.to, 'to') : now;
  const from = input.from ? parse(input.from, 'from') : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from >= to) throw AdminErrors.validation('`from` must be before `to`.');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) throw AdminErrors.validation(`A window covers at most ${MAX_WINDOW_DAYS} days.`);
  return { from, to };
}

function parse(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw AdminErrors.validation(`\`${field}\` is not a valid time.`);
  return d;
}
