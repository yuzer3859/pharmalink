import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomUUID } from 'crypto';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationDeliveryAdminPortAdapter } from '../../notifications/application/ports/inbound/notification-delivery-admin.port';
import { DeliveryJobStatus, NotificationChannel, NotificationStatus } from '../../notifications/domain/enums';
import {
  DeliveryAttemptAdminRecord,
  DeliveryJobRecord,
  DeliveryJobSearchCriteria,
  IDeliveryAdminRepository,
} from '../../notifications/domain/repositories/delivery-admin.repository';
import { AdminDeliveryQueueController } from '../interface/controllers/admin-delivery-queue.controller';
import { ListDeliveryJobsQueryDto } from '../interface/dtos/delivery-queue.dto';
import { toDeliveryAttemptResponse, toDeliveryJobListResponse, toDeliveryJobResponse, toDeliveryQueueSummaryResponse } from '../interface/dtos/delivery-queue.response';
import {
  GetDeliveryJobQuery,
  GetDeliveryQueueSummaryQuery,
  ListDeliveryAttemptsQuery,
  ListDeliveryJobsQuery,
} from './queries/delivery-queue.queries';

class Repo implements IDeliveryAdminRepository {
  jobs: DeliveryJobRecord[] = [];
  attempts: Array<DeliveryAttemptAdminRecord & { notificationId: string; errorDetail?: string }> = [];
  last: { c: DeliveryJobSearchCriteria; page: number; size: number } | null = null;
  async listJobs(c: DeliveryJobSearchCriteria, page: number, size: number) {
    this.last = { c, page, size };
    const hit = this.jobs
      .filter((j) => (!c.channel || j.channel === c.channel) && (!c.status || j.status === c.status) && (!c.notificationId || j.notificationId === c.notificationId))
      .filter((j) => (!c.createdFrom || j.createdAt >= c.createdFrom) && (!c.createdTo || j.createdAt <= c.createdTo))
      .filter((j) => (!c.nextAttemptFrom || j.nextAttemptAt >= c.nextAttemptFrom) && (!c.nextAttemptTo || j.nextAttemptAt <= c.nextAttemptTo))
      .sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id));
    return { items: hit.slice((page - 1) * size, page * size), total: hit.length };
  }
  async findJob(id: string) {
    return this.jobs.find((j) => j.id === id) ?? null;
  }
  async attemptsOf(notificationId: string, channel: NotificationChannel) {
    // The real adapter never selects errorDetail; the fake strips it the same way.
    return this.attempts
      .filter((a) => a.notificationId === notificationId && a.channel === channel)
      .sort((a, b) => a.attemptNumber - b.attemptNumber || +a.attemptedAt - +b.attemptedAt)
      .map(({ notificationId: _n, errorDetail: _e, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
  }
  async countJobs() {
    const by = <K extends 'status' | 'channel'>(k: K) => {
      const m = new Map<string, number>();
      for (const j of this.jobs) m.set(j[k], (m.get(j[k]) ?? 0) + 1);
      return [...m].map(([v, count]) => ({ [k]: v, count }));
    };
    return { total: this.jobs.length, byStatus: by('status') as never, byChannel: by('channel') as never };
  }
}

describe('Admin notification delivery queue (application)', () => {
  let repo: Repo;
  let port: NotificationDeliveryAdminPortAdapter;
  const T = (d: string) => new Date(`2026-10-0${d}T10:00:00.000Z`);
  const job = (over: Partial<DeliveryJobRecord> = {}): DeliveryJobRecord => ({
    id: randomUUID(),
    notificationId: randomUUID(),
    channel: NotificationChannel.EMAIL,
    status: DeliveryJobStatus.PENDING,
    attemptCount: 0,
    nextAttemptAt: T('8'),
    leaseExpiresAt: null,
    lastErrorCode: null,
    completedAt: null,
    createdAt: T('8'),
    updatedAt: T('8'),
    ...over,
  });

  beforeEach(() => {
    repo = new Repo();
    port = new NotificationDeliveryAdminPortAdapter(repo);
  });

  describe('list', () => {
    it('filters by channel, status, notification and dates; newest first with an id tie-break; paging clamped', async () => {
      const a = job({ channel: NotificationChannel.SMS, createdAt: T('1') });
      const b = job({ status: DeliveryJobStatus.EXHAUSTED, createdAt: T('5'), nextAttemptAt: T('6') });
      const c = job({ channel: NotificationChannel.PUSH, status: DeliveryJobStatus.COMPLETED, createdAt: T('8') });
      const d = job({ createdAt: T('8') });
      repo.jobs.push(a, b, c, d);
      const q = new ListDeliveryJobsQuery(port);
      const ids = async (input: object) => (await q.execute(input)).items.map((j) => j.id);

      expect(await ids({})).toEqual([[c, d].sort((x, y) => y.id.localeCompare(x.id)).map((j) => j.id), b.id, a.id].flat());
      expect(repo.last).toMatchObject({ page: 1, size: 20 });
      expect(await ids({ channel: NotificationChannel.SMS })).toEqual([a.id]);
      expect(await ids({ status: DeliveryJobStatus.EXHAUSTED })).toEqual([b.id]);
      expect(await ids({ notificationId: c.notificationId })).toEqual([c.id]);
      expect(await ids({ createdFrom: T('2'), createdTo: T('6') })).toEqual([b.id]);
      expect(await ids({ nextAttemptFrom: T('6'), nextAttemptTo: T('7') })).toEqual([b.id]);
      await q.execute({ page: -1, size: 1000 });
      expect(repo.last).toMatchObject({ page: 1, size: 100 });
      expect(repo.last!.c).toEqual({});
    });

    const dto = (plain: object) => validateSync(plainToInstance(ListDeliveryJobsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true });
    it('accepts the documented filters and refuses anything else', () => {
      expect(dto({ channel: 'EMAIL', status: 'PENDING', notificationId: randomUUID(), createdFrom: '2026-10-01T00:00:00Z', createdTo: '2026-10-02T00:00:00Z', nextAttemptFrom: '2026-10-01T00:00:00Z', nextAttemptTo: '2026-10-09T00:00:00Z', page: 2, size: 100 })).toEqual([]);
      for (const bad of [
        { channel: 'IN_APP' }, { status: 'FAILED' }, { notificationId: 'nope' }, { createdFrom: 'today' }, { size: 101 }, { size: 0 }, { page: 0 },
        { email: 'a@example.com' }, { phone: '+251911000000' }, { provider: 'resend' }, { recipientUserId: randomUUID() }, { where: '{}' },
      ]) {
        expect({ bad, ok: dto(bad).length === 0 }).toEqual({ bad, ok: false });
      }
    });

    it('the list response carries the job’s operational columns only', async () => {
      repo.jobs.push(job({ lastErrorCode: 'EMAIL_RATE_LIMITED', attemptCount: 2 }));
      const res = toDeliveryJobListResponse(await new ListDeliveryJobsQuery(port).execute({}));
      expect(Object.keys(res.items[0])).toEqual(['id', 'notificationId', 'channel', 'status', 'attemptCount', 'nextAttemptAt', 'leaseExpiresAt', 'lastErrorCode', 'completedAt', 'createdAt', 'updatedAt']);
    });
  });

  describe('detail and attempts', () => {
    it('detail: known → the job; unknown → 404', async () => {
      const j = job();
      repo.jobs.push(j);
      expect(toDeliveryJobResponse(await new GetDeliveryJobQuery(port).execute(j.id))).toMatchObject({ id: j.id, status: 'PENDING' });
      await expect(new GetDeliveryJobQuery(port).execute(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('attempts: oldest first; only this job’s (notification, channel); no errorDetail; message id as a suffix', async () => {
      const j = job({ channel: NotificationChannel.EMAIL });
      repo.jobs.push(j);
      const base = { channel: NotificationChannel.EMAIL, provider: 'resend', notificationId: j.notificationId, errorDetail: 'raw provider text customer@example.com' };
      repo.attempts.push(
        { ...base, id: 'a2', attemptNumber: 2, providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', status: NotificationStatus.SENT, errorCode: null, attemptedAt: T('3') },
        { ...base, id: 'a1', attemptNumber: 1, providerMessageId: null, status: NotificationStatus.FAILED, errorCode: 'EMAIL_RATE_LIMITED', attemptedAt: T('2') },
        { ...base, id: 'a3', attemptNumber: 2, providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', status: NotificationStatus.DELIVERED, errorCode: null, attemptedAt: T('4') },
        { ...base, id: 'other-channel', channel: NotificationChannel.SMS, attemptNumber: 1, providerMessageId: null, status: NotificationStatus.SENT, errorCode: null, attemptedAt: T('2') },
      );
      const res = (await new ListDeliveryAttemptsQuery(port).execute(j.id)).map(toDeliveryAttemptResponse);
      expect(res.map((r) => [r.id, r.attemptNumber, r.status, r.errorCode, r.providerMessageIdSuffix])).toEqual([
        ['a1', 1, 'FAILED', 'EMAIL_RATE_LIMITED', null],
        ['a2', 2, 'SENT', null, '…6dc2e794'],
        ['a3', 2, 'DELIVERED', null, '…6dc2e794'],
      ]);
      expect(Object.keys(res[0])).toEqual(['id', 'attemptNumber', 'channel', 'provider', 'providerMessageIdSuffix', 'status', 'errorCode', 'attemptedAt']);
      const raw = JSON.stringify(res);
      expect(raw).not.toMatch(/errorDetail|raw provider|customer@|49a3999c-0ce1/);
    });

    it('attempts: a job with none → []; an unknown job → 404', async () => {
      const j = job();
      repo.jobs.push(j);
      expect(await new ListDeliveryAttemptsQuery(port).execute(j.id)).toEqual([]);
      await expect(new ListDeliveryAttemptsQuery(port).execute(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('summary', () => {
    it('exact counts by status and by channel, zeros included; an empty queue is all zeros', async () => {
      const empty = toDeliveryQueueSummaryResponse(await new GetDeliveryQueueSummaryQuery(port).execute());
      expect(empty.jobs).toEqual({ total: 0, byStatus: { PENDING: 0, PROCESSING: 0, COMPLETED: 0, SUPPRESSED: 0, EXHAUSTED: 0 }, byChannel: { PUSH: 0, SMS: 0, EMAIL: 0 } });
      repo.jobs.push(
        job(),
        job({ channel: NotificationChannel.SMS }),
        job({ channel: NotificationChannel.PUSH, status: DeliveryJobStatus.COMPLETED }),
        job({ status: DeliveryJobStatus.SUPPRESSED }),
        job({ status: DeliveryJobStatus.EXHAUSTED }),
      );
      const s = toDeliveryQueueSummaryResponse(await new GetDeliveryQueueSummaryQuery(port).execute());
      expect(s.jobs).toEqual({ total: 5, byStatus: { PENDING: 2, PROCESSING: 0, COMPLETED: 1, SUPPRESSED: 1, EXHAUSTED: 1 }, byChannel: { PUSH: 1, SMS: 1, EMAIL: 3 } });
      expect(Object.keys(s)).toEqual(['generatedAt', 'jobs']);
    });
  });

  describe('authorization and surface', () => {
    it('every route takes notification:queue:read; there are only GET routes', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDeliveryQueueController)).toEqual(['notification:queue:read']);
      const methods = Object.getOwnPropertyNames(AdminDeliveryQueueController.prototype).filter((m) => m !== 'constructor');
      for (const m of methods) {
        // RequestMethod.GET === 0
        expect({ m, method: Reflect.getMetadata('method', AdminDeliveryQueueController.prototype[m as keyof AdminDeliveryQueueController]) }).toEqual({ m, method: 0 });
      }
    });

    it('only ADMIN (and SUPER_ADMIN by wildcard) holds it; notification:read:own never implies it', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'notification:queue:read') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['notification:read:own', 'notification:manage:own'], 'notification:queue:read')).toBe(false);
    });
  });
});
