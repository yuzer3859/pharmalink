import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../../prisma/rbac-catalog';
import { PERMISSIONS_KEY } from '../../../../shared/rbac/permissions.decorator';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { AdminActivityController } from '../../interface/controllers/admin-activity.controller';
import { AdminActivityService, detectAnomalies, eatHour, MAX_WINDOW_DAYS, summarize, window } from './admin-activity.service';

const ACTOR = '11111111-1111-4111-8111-111111111111';
let seq = 0;
/** An entry at `iso` (UTC). 09:00 UTC is 12:00 EAT: working hours. */
const entry = (iso: string, over: Partial<{ action: string; resourceType: string; resourceId: string | null; ip: string | null }> = {}) => ({
  id: `e${++seq}`,
  actorUserId: ACTOR,
  action: over.action ?? 'DISPUTE_MESSAGE_ADDED',
  resourceType: over.resourceType ?? 'DisputeCase',
  resourceId: over.resourceId ?? 'x',
  ip: over.ip === undefined ? '10.0.0.1' : over.ip,
  createdAt: new Date(iso),
});
const at = (base: string, minutes: number) => new Date(new Date(base).getTime() + minutes * 60_000).toISOString();
const rules = (entries: ReturnType<typeof entry>[]) => detectAnomalies(ACTOR, entries).map((f) => f.rule);

describe('Admin activity monitoring (Work 88)', () => {
  it('judges hours in East Africa Time', () => {
    expect(eatHour(new Date('2026-11-06T19:00:00Z'))).toBe(22);
    expect(eatHour(new Date('2026-11-06T02:59:00Z'))).toBe(5);
    expect(eatHour(new Date('2026-11-06T03:00:00Z'))).toBe(6);
  });

  it('flags nothing for ordinary working-hours activity', () => {
    expect(rules([entry('2026-11-06T09:00:00Z'), entry('2026-11-06T10:00:00Z')])).toEqual([]);
  });

  it('flags off-hours actions (22:00–06:00 EAT) with examples', () => {
    const flags = detectAnomalies(ACTOR, [entry('2026-11-06T18:59:00Z'), entry('2026-11-06T19:00:00Z'), entry('2026-11-07T02:30:00Z')]);
    expect(flags).toEqual([expect.objectContaining({ rule: 'OFF_HOURS', count: 2, firstAt: new Date('2026-11-06T19:00:00Z') })]);
    expect(flags[0].exampleIds).toHaveLength(2);
  });

  it('flags a burst of 30 entries within 10 minutes, not 29, nor 30 spread wider', () => {
    const base = '2026-11-06T08:00:00Z';
    const burst = Array.from({ length: 30 }, (_, i) => entry(at(base, i * 0.3)));
    expect(rules(burst)).toEqual(['BURST']);
    expect(rules(burst.slice(1))).toEqual([]);
    const spread = Array.from({ length: 30 }, (_, i) => entry(at(base, i * 0.5)));
    expect(rules(spread)).toEqual([]);
    expect(detectAnomalies(ACTOR, burst)[0].exampleIds).toHaveLength(5);
  });

  it('flags ten sensitive actions within 24 hours, not nine', () => {
    const base = '2026-11-06T06:00:00Z';
    const ten = Array.from({ length: 10 }, (_, i) => entry(at(base, i * 60), { action: 'identity.account.suspended', resourceType: 'user', resourceId: `u${i}` }));
    expect(rules(ten)).toEqual(['SENSITIVE_VOLUME']);
    expect(rules(ten.slice(1))).toEqual([]);
    const ordinary = Array.from({ length: 10 }, (_, i) => entry(at(base, i * 60)));
    expect(rules(ordinary)).toEqual([]);
  });

  it('flags a sensitive action on one’s own account', () => {
    expect(rules([entry('2026-11-06T09:00:00Z', { action: 'rbac.user_role.assigned', resourceType: 'user', resourceId: ACTOR })])).toEqual(['SELF_TARGETED']);
    // A non-sensitive action on oneself is not flagged.
    expect(rules([entry('2026-11-06T09:00:00Z', { action: 'PROFILE_UPDATED', resourceType: 'user', resourceId: ACTOR })])).toEqual([]);
  });

  it('flags five distinct IPs in the window, not four', () => {
    const five = ['1', '2', '3', '4', '5'].map((n, i) => entry(at('2026-11-06T08:00:00Z', i * 60), { ip: `10.0.0.${n}` }));
    expect(rules(five)).toEqual(['MANY_IPS']);
    expect(detectAnomalies(ACTOR, five)[0].count).toBe(5);
    expect(rules(five.slice(1))).toEqual([]);
  });

  it('summarizes counts by action, first and last, and distinct IPs', () => {
    const s = summarize({ userId: ACTOR, email: 'a@x', phone: null, status: 'ACTIVE', roles: ['ADMIN'] }, [
      entry('2026-11-06T08:00:00Z', { action: 'B' }),
      entry('2026-11-06T09:00:00Z', { action: 'A', ip: null }),
      entry('2026-11-06T10:00:00Z', { action: 'B', ip: '10.0.0.2' }),
    ]);
    expect(s.byAction).toEqual([{ action: 'B', count: 2 }, { action: 'A', count: 1 }]);
    expect([s.total, s.distinctIps]).toEqual([3, 2]);
    expect([s.firstAt?.toISOString(), s.lastAt?.toISOString()]).toEqual(['2026-11-06T08:00:00.000Z', '2026-11-06T10:00:00.000Z']);
  });

  it('bounds the window: 7 days by default, at most 31, from before to', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(window({}, now)).toEqual({ from: new Date('2026-10-30T12:00:00Z'), to: now });
    expect(() => window({ from: '2026-11-06T12:00:00Z', to: '2026-11-06T12:00:00Z' }, now)).toThrow();
    const max = new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000).toISOString();
    expect(window({ from: max }, now).from.toISOString()).toBe(max);
    expect(() => window({ from: new Date(now.getTime() - MAX_WINDOW_DAYS * 86_400_000 - 1).toISOString() }, now)).toThrow();
  });

  it('reports every staff member, flagged first, and audits the read', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const staff = { listStaff: jest.fn().mockResolvedValue([
      { userId: other, email: null, phone: null, status: 'ACTIVE', roles: ['FINANCE_OFFICER'] },
      { userId: ACTOR, email: null, phone: null, status: 'ACTIVE', roles: ['ADMIN'] },
    ]) };
    const auditRead = { activityOf: jest.fn().mockResolvedValue({ items: [entry('2026-11-06T20:00:00Z')], truncated: true }) };
    const audit = { record: jest.fn() };
    const svc = new AdminActivityService(staff, auditRead as never, audit as never);
    const report = await svc.report({}, { userId: 'viewer' }, new Date('2026-11-06T21:00:00Z'));
    expect(report.staff.map((s) => [s.userId, s.total, s.flags.map((f) => f.rule)])).toEqual([[ACTOR, 1, ['OFF_HOURS']], [other, 0, []]]);
    expect(report.truncated).toBe(true);
    expect(auditRead.activityOf).toHaveBeenCalledWith([other, ACTOR], new Date('2026-10-30T21:00:00Z'), new Date('2026-11-06T21:00:00Z'), 20_000);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'viewer', action: 'ADMIN_ACTIVITY_VIEWED', context: expect.objectContaining({ flagged: 1 }) }));
  });

  it('refuses entries for someone who is not staff, without auditing', async () => {
    const audit = { record: jest.fn() };
    const svc = new AdminActivityService({ listStaff: jest.fn().mockResolvedValue([]) }, { search: jest.fn() } as never, audit as never);
    await expect(svc.entriesOf(ACTOR, { page: 1, size: 25 }, { userId: 'v' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is SUPER_ADMIN’s alone', () => {
    expect(PERMISSIONS.some((p) => p.key === 'staff:monitor:any')).toBe(true);
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      expect({ role, ok: hasPermission(grants, 'staff:monitor:any') }).toEqual({ role, ok: role === 'SUPER_ADMIN' });
    }
    expect(Reflect.getMetadata('path', AdminActivityController)).toBe('admin/admins/activity');
    expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminActivityController)).toEqual(['staff:monitor:any']);
  });
});
