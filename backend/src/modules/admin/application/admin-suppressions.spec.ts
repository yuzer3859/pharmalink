import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomUUID } from 'crypto';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationSuppressionAdminPortAdapter } from '../../notifications/application/ports/inbound/notification-suppression-admin.port';
import { DestinationSuppressionService } from '../../notifications/application/services/destination-suppression.service';
import { NotificationChannel } from '../../notifications/domain/enums';
import { IDestinationSuppressionRepository } from '../../notifications/domain/repositories/email-webhook.repository';
import { ISuppressionAdminRepository, SuppressionRecord, SuppressionSearchCriteria } from '../../notifications/domain/repositories/suppression-admin.repository';
import { suppressionKeyOf } from '../../notifications/domain/suppression';
import { AdminSuppressionsController } from '../interface/controllers/admin-suppressions.controller';
import { ListSuppressionsQueryDto } from '../interface/dtos/suppression.dto';
import { toSuppressionListResponse, toSuppressionResponse } from '../interface/dtos/suppression.response';
import { ADMIN_NOTIFICATION_SUPPRESSION_REMOVED, RemoveSuppressionCommand } from './commands/remove-suppression.command';
import { GetSuppressionQuery } from './queries/get-suppression.query';
import { ListSuppressionsQuery } from './queries/list-suppressions.query';

/** `suppression_list` in memory, implementing both of Module 13's ports over it. */
class Suppressions implements ISuppressionAdminRepository, IDestinationSuppressionRepository {
  rows: SuppressionRecord[] = [];
  lastQuery: { criteria: SuppressionSearchCriteria; page: number; size: number } | null = null;
  async list(criteria: SuppressionSearchCriteria, page: number, size: number) {
    this.lastQuery = { criteria, page, size };
    const hits = this.rows
      .filter((r) => (!criteria.reason || r.reason === criteria.reason) && (!criteria.channel || r.channel === criteria.channel))
      .filter((r) => (!criteria.createdFrom || r.createdAt >= criteria.createdFrom) && (!criteria.createdTo || r.createdAt <= criteria.createdTo))
      .sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id));
    return { items: hits.slice((page - 1) * size, page * size), total: hits.length };
  }
  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async deleteById(id: string) {
    const row = this.rows.find((r) => r.id === id) ?? null;
    this.rows = this.rows.filter((r) => r.id !== id);
    return row;
  }
  async isSuppressed(channel: NotificationChannel, key: string) {
    return this.rows.some((r) => r.channel === channel && r.address === key);
  }
}

const logger = () => ({ setContext: () => undefined, log: () => undefined, warn: () => undefined }) as unknown as AppLogger;

describe('Admin notification suppressions (application)', () => {
  const EMAIL = 'customer.a@example.com';
  let store: Suppressions;
  let audits: Array<Record<string, unknown>>;
  let port: NotificationSuppressionAdminPortAdapter;
  const audit = { record: async (e: Record<string, unknown>) => void audits.push(e) } as unknown as AuditService;
  const row = (over: Partial<SuppressionRecord> = {}): SuppressionRecord => ({
    id: randomUUID(),
    channel: NotificationChannel.EMAIL,
    address: suppressionKeyOf(`${randomUUID().slice(0, 6)}@example.com`),
    reason: 'PERMANENT_BOUNCE',
    createdAt: new Date('2026-10-08T10:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    store = new Suppressions();
    audits = [];
    port = new NotificationSuppressionAdminPortAdapter(store, logger());
  });

  describe('list', () => {
    it('newest first, with filters on stored fields, and paging clamped to 1..100 (default 20)', async () => {
      const old = row({ createdAt: new Date('2026-10-01T00:00:00Z') });
      const mid = row({ reason: 'COMPLAINT', createdAt: new Date('2026-10-05T00:00:00Z') });
      const recent = row({ createdAt: new Date('2026-10-08T00:00:00Z') });
      store.rows.push(old, mid, recent);
      const q = new ListSuppressionsQuery(port);

      expect((await q.execute({})).items.map((i) => i.id)).toEqual([recent.id, mid.id, old.id]);
      expect(store.lastQuery).toMatchObject({ page: 1, size: 20 });
      expect((await q.execute({ reason: 'COMPLAINT' })).items.map((i) => i.id)).toEqual([mid.id]);
      expect((await q.execute({ createdFrom: new Date('2026-10-02T00:00:00Z'), createdTo: new Date('2026-10-06T00:00:00Z') })).items.map((i) => i.id)).toEqual([mid.id]);
      await q.execute({ page: 0, size: 1000 });
      expect(store.lastQuery).toMatchObject({ page: 1, size: 100 });
      const page2 = await q.execute({ page: 2, size: 2 });
      expect(page2).toMatchObject({ total: 3, page: 2, size: 2 });
      expect(page2.items.map((i) => i.id)).toEqual([old.id]);
    });

    it('each item carries id, channel, reason, a short fingerprint and createdAt — never the address or full hash', async () => {
      const r = row({ address: suppressionKeyOf(EMAIL) });
      store.rows.push(r);
      const res = toSuppressionListResponse(await new ListSuppressionsQuery(port).execute({}));
      expect(res.items).toEqual([{ id: r.id, channel: 'EMAIL', reason: 'PERMANENT_BOUNCE', destinationFingerprint: `${r.address.slice(0, 15)}…`, createdAt: '2026-10-08T10:00:00.000Z' }]);
      const raw = JSON.stringify(res);
      expect(raw).not.toContain(EMAIL);
      expect(raw).not.toContain(r.address);
    });

    it('a row not in the hashed form is never echoed: its fingerprint is null', async () => {
      store.rows.push(row({ address: EMAIL }));
      const res = toSuppressionListResponse(await new ListSuppressionsQuery(port).execute({}));
      expect(res.items[0].destinationFingerprint).toBeNull();
      expect(JSON.stringify(res)).not.toContain(EMAIL);
    });

    const dto = (plain: object) => validateSync(plainToInstance(ListSuppressionsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true });
    it('accepts the documented filters; refuses address / hash / unknown filters and out-of-range paging', () => {
      expect(dto({ channel: 'EMAIL', reason: 'COMPLAINT', createdFrom: '2026-10-01T00:00:00Z', createdTo: '2026-10-08T00:00:00Z', page: 1, size: 100 })).toEqual([]);
      for (const bad of [{ address: EMAIL }, { email: EMAIL }, { hash: 'sha256:abc' }, { reason: 'BECAUSE' }, { channel: 'FAX' }, { size: 101 }, { size: 0 }, { page: 0 }, { createdFrom: 'yesterday' }]) {
        expect({ bad, ok: dto(bad).length === 0 }).toEqual({ bad, ok: false });
      }
    });
  });

  describe('detail', () => {
    it('returns the safe view; unknown → 404', async () => {
      const r = row();
      store.rows.push(r);
      expect(toSuppressionResponse(await new GetSuppressionQuery(port).execute(r.id))).toMatchObject({ id: r.id, reason: 'PERMANENT_BOUNCE' });
      await expect(new GetSuppressionQuery(port).execute(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('remove', () => {
    it('removes the row and records one admin audit with id, channel, previous reason and time — no destination', async () => {
      const r = row({ address: suppressionKeyOf(EMAIL), reason: 'COMPLAINT' });
      store.rows.push(r);
      const removed = await new RemoveSuppressionCommand(port, audit).execute({ actorUserId: 'admin-1', suppressionId: r.id, ip: '203.0.113.9' });
      expect(removed.id).toBe(r.id);
      expect(store.rows).toEqual([]);
      expect(audits).toEqual([
        {
          actorUserId: 'admin-1',
          action: ADMIN_NOTIFICATION_SUPPRESSION_REMOVED,
          resourceType: 'NotificationSuppression',
          resourceId: r.id,
          context: { suppressionId: r.id, channel: 'EMAIL', previousReason: 'COMPLAINT', suppressedAt: '2026-10-08T10:00:00.000Z' },
          ip: '203.0.113.9',
        },
      ]);
      expect(JSON.stringify(audits)).not.toMatch(new RegExp(`${EMAIL}|${r.address.slice(7)}`));
    });

    it('an unknown or already-removed id → 404 and no audit', async () => {
      const r = row();
      store.rows.push(r);
      const cmd = new RemoveSuppressionCommand(port, audit);
      await cmd.execute({ actorUserId: 'admin-1', suppressionId: r.id, ip: null });
      const again = await cmd.execute({ actorUserId: 'admin-1', suppressionId: r.id, ip: null }).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(ApiException);
      expect((again as ApiException).code).toBe('NOT_FOUND');
      await expect(cmd.execute({ actorUserId: 'admin-1', suppressionId: randomUUID(), ip: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(audits).toHaveLength(1);
    });

    it('after removal the send-time check no longer suppresses that destination (future sends may proceed); others stay suppressed', async () => {
      const mine = row({ address: suppressionKeyOf(EMAIL) });
      const other = row({ address: suppressionKeyOf('customer.b@example.com') });
      store.rows.push(mine, other);
      const check = new DestinationSuppressionService(store);
      expect(await check.isSuppressed(NotificationChannel.EMAIL, EMAIL)).toBe(true);
      await new RemoveSuppressionCommand(port, audit).execute({ actorUserId: 'admin-1', suppressionId: mine.id, ip: null });
      expect(await check.isSuppressed(NotificationChannel.EMAIL, EMAIL)).toBe(false);
      expect(await check.isSuppressed(NotificationChannel.EMAIL, 'customer.b@example.com')).toBe(true);
    });
  });

  describe('authorization', () => {
    const required = (m: keyof AdminSuppressionsController) => Reflect.getMetadata(PERMISSIONS_KEY, AdminSuppressionsController.prototype[m]);

    it('reads take suppression:read:any, removal suppression:manage:any', () => {
      expect([required('search'), required('detail'), required('removeOne')]).toEqual([['suppression:read:any'], ['suppression:read:any'], ['suppression:manage:any']]);
    });

    it('only ADMIN (and SUPER_ADMIN by wildcard) holds them; a user’s notification keys never imply them', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        const allowed = role === 'ADMIN' || role === 'SUPER_ADMIN';
        expect({ role, read: hasPermission(grants, 'suppression:read:any'), manage: hasPermission(grants, 'suppression:manage:any') }).toEqual({
          role,
          read: allowed,
          manage: allowed,
        });
      }
      expect(hasPermission(['notification:read:own', 'notification:manage:own'], 'suppression:read:any')).toBe(false);
    });
  });
});
