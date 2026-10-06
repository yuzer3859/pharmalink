import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DigestFrequency, NotificationCategory, NotificationChannel } from '../domain/enums';
import {
  CONFIGURABLE_CATEGORIES,
  DEFAULT_CHANNEL_PREFERENCE,
  PreferenceSource,
  resolveChannelPreference,
} from '../domain/preferences';
import {
  ChannelPreferenceChange,
  INotificationPreferenceRepository,
  StoredChannelPreference,
} from '../domain/repositories/notification-preference.repository';
import { NotificationTemplateCode, NOTIFICATION_TEMPLATES } from '../domain/templates';
import { NotificationPreferencesController } from '../interface/controllers/notification-preferences.controller';
import {
  NotificationPreferenceCategoryParamDto,
  UpdateNotificationPreferencesDto,
} from '../interface/dtos/notification-preference.dto';
import { toCategoryPreferencesResponse } from '../interface/dtos/notification-preference.response';
import { UpdateNotificationPreferencesCommand } from './commands/update-notification-preferences.command';
import { GetNotificationPreferencesQuery } from './queries/get-notification-preferences.query';

/** `channel_preferences` in memory, keyed like its unique index. */
class InMemoryPreferenceRepository implements INotificationPreferenceRepository {
  rows = new Map<string, StoredChannelPreference & { userId: string }>();
  writes = 0;

  async listForUser(userId: string, category?: NotificationCategory): Promise<StoredChannelPreference[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && (!category || r.category === category))
      .map((r) => ({ category: r.category, channel: r.channel, enabled: r.enabled, digestFrequency: r.digestFrequency }));
  }

  async upsert(userId: string, category: NotificationCategory, changes: ChannelPreferenceChange[]): Promise<void> {
    this.writes++;
    for (const c of changes) {
      const key = `${userId}|${category}|${c.channel}`;
      const existing = this.rows.get(key);
      this.rows.set(key, {
        userId,
        category,
        channel: c.channel,
        enabled: c.enabled,
        digestFrequency: c.digestFrequency ?? existing?.digestFrequency ?? DEFAULT_CHANNEL_PREFERENCE.digestFrequency,
      });
    }
  }
}

/**
 * Module 13 Work 11: notification preferences — the policy, its precedence rule, the read and
 * write paths over a fake repository, and the request contract.
 */
describe('Notification preferences (application)', () => {
  const A = 'user-a';
  const B = 'user-b';
  let repo: InMemoryPreferenceRepository;
  let query: GetNotificationPreferencesQuery;
  let update: UpdateNotificationPreferencesCommand;

  beforeEach(() => {
    repo = new InMemoryPreferenceRepository();
    query = new GetNotificationPreferencesQuery(repo);
    update = new UpdateNotificationPreferencesCommand(repo, query);
  });

  const channelsOf = async (userId: string, category: NotificationCategory) =>
    (await query.forCategory(userId, category)).channels.map((c) => [c.channel, c.enabled, c.digestFrequency, c.source]);

  const expectValidation = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiException);
    expect((err as ApiException).code).toBe(ErrorCode.VALIDATION_ERROR);
  };

  describe('policy and precedence', () => {
    it('configures exactly the categories the templates emit', () => {
      const used = new Set(Object.values(NOTIFICATION_TEMPLATES).map((t) => t.category));
      expect([...CONFIGURABLE_CATEGORIES].sort()).toEqual([...used].sort());
      expect([...used].sort()).toEqual(['SECURITY', 'SYSTEM', 'TRANSACTIONAL']);
      expect(Object.keys(NOTIFICATION_TEMPLATES)).toContain(NotificationTemplateCode.ORDER_PLACED);
    });

    it('defaults to the table’s own column defaults: enabled, IMMEDIATE', () => {
      expect(DEFAULT_CHANNEL_PREFERENCE).toEqual({ enabled: true, digestFrequency: DigestFrequency.IMMEDIATE });
      expect(resolveChannelPreference(NotificationChannel.SMS, null)).toEqual({
        channel: 'SMS', enabled: true, digestFrequency: 'IMMEDIATE', configurable: true, source: PreferenceSource.DEFAULT,
      });
    });

    it('a stored row wins over the default', () => {
      expect(resolveChannelPreference(NotificationChannel.EMAIL, { enabled: false, digestFrequency: DigestFrequency.DAILY })).toEqual({
        channel: 'EMAIL', enabled: false, digestFrequency: 'DAILY', configurable: true, source: PreferenceSource.STORED,
      });
    });

    it('IN_APP is always enabled and not configurable — even against a stored row', () => {
      expect(resolveChannelPreference(NotificationChannel.IN_APP, { enabled: false, digestFrequency: DigestFrequency.WEEKLY })).toEqual({
        channel: 'IN_APP', enabled: true, digestFrequency: 'IMMEDIATE', configurable: false, source: PreferenceSource.POLICY,
      });
    });
  });

  describe('reading', () => {
    it('with nothing stored, reports every category and channel at its default, and writes nothing', async () => {
      const all = await query.all(A);
      expect(all.map((c) => c.category)).toEqual(['TRANSACTIONAL', 'SECURITY', 'SYSTEM']);
      for (const c of all) {
        expect(c.channels.map((p) => [p.channel, p.enabled, p.source])).toEqual([
          ['IN_APP', true, 'POLICY'],
          ['PUSH', true, 'DEFAULT'],
          ['SMS', true, 'DEFAULT'],
          ['EMAIL', true, 'DEFAULT'],
        ]);
      }
      expect(repo.writes).toBe(0);
      expect(repo.rows.size).toBe(0);
    });

    it('refuses a category with no template (REMINDER, MARKETING) as a validation error', async () => {
      await expectValidation(query.forCategory(A, NotificationCategory.MARKETING));
      await expectValidation(query.forCategory(A, NotificationCategory.REMINDER));
    });

    it('forChannel — the lookup a delivery channel will make — follows the same precedence', async () => {
      await update.execute({ userId: A, category: NotificationCategory.SECURITY, channels: [{ channel: NotificationChannel.SMS, enabled: false }] });
      expect((await query.forChannel(A, NotificationCategory.SECURITY, NotificationChannel.SMS)).enabled).toBe(false);
      expect((await query.forChannel(A, NotificationCategory.SECURITY, NotificationChannel.PUSH)).source).toBe('DEFAULT');
      expect((await query.forChannel(A, NotificationCategory.TRANSACTIONAL, NotificationChannel.SMS)).source).toBe('DEFAULT');
      expect(await query.forChannel(A, NotificationCategory.SECURITY, NotificationChannel.IN_APP)).toMatchObject({ enabled: true, source: 'POLICY' });
    });
  });

  describe('writing', () => {
    it('creates a missing preference and persists it', async () => {
      const view = await update.execute({
        userId: A,
        category: NotificationCategory.TRANSACTIONAL,
        channels: [{ channel: NotificationChannel.SMS, enabled: false, digestFrequency: DigestFrequency.DAILY }],
      });
      expect(view.channels.find((c) => c.channel === 'SMS')).toMatchObject({ enabled: false, digestFrequency: 'DAILY', source: 'STORED' });
      expect(await channelsOf(A, NotificationCategory.TRANSACTIONAL)).toEqual([
        ['IN_APP', true, 'IMMEDIATE', 'POLICY'],
        ['PUSH', true, 'IMMEDIATE', 'DEFAULT'],
        ['SMS', false, 'DAILY', 'STORED'],
        ['EMAIL', true, 'IMMEDIATE', 'DEFAULT'],
      ]);
      expect(repo.rows.size).toBe(1);
    });

    it('updates an existing preference; an omitted digest keeps the stored one', async () => {
      const cat = NotificationCategory.SYSTEM;
      await update.execute({ userId: A, category: cat, channels: [{ channel: NotificationChannel.EMAIL, enabled: false, digestFrequency: DigestFrequency.WEEKLY }] });
      await update.execute({ userId: A, category: cat, channels: [{ channel: NotificationChannel.EMAIL, enabled: true }] });
      expect((await channelsOf(A, cat))[3]).toEqual(['EMAIL', true, 'WEEKLY', 'STORED']);
      expect(repo.rows.size).toBe(1);
    });

    it('leaves unlisted channels and other categories untouched; repeating a request changes nothing', async () => {
      const req = { userId: A, category: NotificationCategory.SECURITY, channels: [{ channel: NotificationChannel.PUSH, enabled: false }] };
      await update.execute(req);
      const once = await query.all(A);
      await update.execute(req);
      expect(await query.all(A)).toEqual(once);
      expect((await channelsOf(A, NotificationCategory.TRANSACTIONAL)).every((c) => c[3] !== 'STORED')).toBe(true);
    });

    it('is per user: B’s change never touches A, and B sees none of A’s', async () => {
      await update.execute({ userId: A, category: NotificationCategory.TRANSACTIONAL, channels: [{ channel: NotificationChannel.SMS, enabled: false }] });
      expect((await channelsOf(B, NotificationCategory.TRANSACTIONAL))[2]).toEqual(['SMS', true, 'IMMEDIATE', 'DEFAULT']);
      await update.execute({ userId: B, category: NotificationCategory.TRANSACTIONAL, channels: [{ channel: NotificationChannel.SMS, enabled: true }] });
      expect((await channelsOf(A, NotificationCategory.TRANSACTIONAL))[2]).toEqual(['SMS', false, 'IMMEDIATE', 'STORED']);
    });

    it.each([
      ['IN_APP', NotificationCategory.TRANSACTIONAL, [{ channel: NotificationChannel.IN_APP, enabled: false }]],
      ['a non-template category', NotificationCategory.MARKETING, [{ channel: NotificationChannel.SMS, enabled: false }]],
      ['an unknown channel', NotificationCategory.SYSTEM, [{ channel: 'FAX' as NotificationChannel, enabled: false }]],
      ['a duplicated channel', NotificationCategory.SYSTEM, [{ channel: NotificationChannel.SMS, enabled: false }, { channel: NotificationChannel.SMS, enabled: true }]],
    ])('refuses %s and stores nothing', async (_label, category, channels) => {
      await expectValidation(update.execute({ userId: A, category, channels }));
      expect(repo.writes).toBe(0);
    });
  });

  describe('request contract', () => {
    const body = (plain: object) =>
      validateSync(plainToInstance(UpdateNotificationPreferencesDto, plain, { enableImplicitConversion: true }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    const param = (plain: object) =>
      validateSync(plainToInstance(NotificationPreferenceCategoryParamDto, plain, { enableImplicitConversion: true }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it('accepts the documented body', () => {
      expect(body({ channels: [{ channel: 'SMS', enabled: false, digestFrequency: 'HOURLY' }, { channel: 'PUSH', enabled: true }] })).toEqual([]);
    });

    it.each(['TRANSACTIONAL', 'SECURITY', 'SYSTEM'])('accepts category %s', (category) => {
      expect(param({ category })).toEqual([]);
    });

    it.each(['MARKETING', 'REMINDER', 'transactional', 'ORDER', ''])('rejects category %p', (category) => {
      expect(param({ category })).not.toEqual([]);
    });

    it.each([
      ['IN_APP channel', { channels: [{ channel: 'IN_APP', enabled: false }] }],
      ['unknown channel', { channels: [{ channel: 'FAX', enabled: false }] }],
      ['invalid digest', { channels: [{ channel: 'SMS', enabled: false, digestFrequency: 'MONTHLY' }] }],
      ['string boolean', { channels: [{ channel: 'SMS', enabled: 'false' }] }],
      ['missing enabled', { channels: [{ channel: 'SMS' }] }],
      ['empty list', { channels: [] }],
      ['duplicate channel', { channels: [{ channel: 'SMS', enabled: true }, { channel: 'SMS', enabled: false }] }],
      ['too many', { channels: [{ channel: 'SMS', enabled: true }, { channel: 'PUSH', enabled: true }, { channel: 'EMAIL', enabled: true }, { channel: 'SMS', enabled: true }] }],
      ['no channels', {}],
      ['userId', { userId: 'someone-else', channels: [{ channel: 'SMS', enabled: true }] }],
      ['actorUserId', { actorUserId: 'x', channels: [{ channel: 'SMS', enabled: true }] }],
      ['updatedBy', { updatedBy: 'x', channels: [{ channel: 'SMS', enabled: true }] }],
      ['id inside a channel', { channels: [{ id: 'row-1', channel: 'SMS', enabled: true }] }],
      ['userId inside a channel', { channels: [{ userId: 'someone-else', channel: 'SMS', enabled: true }] }],
      ['arbitrary JSON', { channels: [{ channel: 'SMS', enabled: true, meta: { a: 1 } }] }],
    ])('rejects %s', (_label, plain) => {
      expect(body(plain)).not.toEqual([]);
    });
  });

  describe('authorization', () => {
    const required = (method: keyof NotificationPreferencesController) =>
      Reflect.getMetadata(PERMISSIONS_KEY, NotificationPreferencesController.prototype[method]) as string[];

    it('reads take notification:read:own; the write takes notification:manage:own', () => {
      expect(required('list')).toEqual(['notification:read:own']);
      expect(required('get')).toEqual(['notification:read:own']);
      expect(required('put')).toEqual(['notification:manage:own']);
    });

    it('every role that reads notifications may manage its own preferences — and only those', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'notification:manage:own') }).toEqual({
          role,
          manage: hasPermission(grants, 'notification:read:own'),
        });
        expect({ role, broad: hasPermission(grants, 'notification:manage:any') && !grants.includes('*') }).toEqual({ role, broad: false });
      }
    });
  });

  it('the response is an explicit allow-list — no row id, owner or timestamp', async () => {
    await update.execute({ userId: A, category: NotificationCategory.SYSTEM, channels: [{ channel: NotificationChannel.PUSH, enabled: false }] });
    const res = toCategoryPreferencesResponse(await query.forCategory(A, NotificationCategory.SYSTEM));
    expect(Object.keys(res)).toEqual(['category', 'channels']);
    for (const c of res.channels) expect(Object.keys(c)).toEqual(['channel', 'enabled', 'digestFrequency', 'configurable', 'source']);
    expect(JSON.stringify(res)).not.toContain(A);
  });
});
