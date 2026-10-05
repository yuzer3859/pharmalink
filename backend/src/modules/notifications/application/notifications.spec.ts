import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  INotificationRepository,
  NewNotification,
  NotificationListFilter,
  NotificationRecord,
} from '../domain/repositories/notification.repository';
import { formatMinorUnits, NotificationTemplateCode, renderNotification } from '../domain/templates';
import { ListNotificationsQueryDto } from '../interface/dtos/notification.dto';
import { toNotificationResponse } from '../interface/dtos/notification.response';
import { MarkAllNotificationsReadCommand } from './commands/mark-all-notifications-read.command';
import { MarkNotificationReadCommand } from './commands/mark-notification-read.command';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { GetUnreadCountQuery } from './queries/get-unread-count.query';
import { ListNotificationsQuery, MAX_NOTIFICATION_PAGE_SIZE } from './queries/list-notifications.query';
import { dedupeKeyFor, EventNotifications } from './support/event-notifications';

/** The repository contract, in memory: unique `dedupeKey`, every read scoped to one recipient. */
class InMemoryNotificationRepository implements INotificationRepository {
  rows: Array<NotificationRecord & { dedupeKey: string; channel: NotificationChannel; eventType: string }> = [];
  private clock = 0;

  async insertIfAbsent(n: NewNotification): Promise<boolean> {
    if (this.rows.some((r) => r.dedupeKey === n.dedupeKey)) return false;
    this.rows.push({
      id: randomUUID(),
      recipientUserId: n.recipientUserId,
      category: n.category,
      templateCode: n.templateCode,
      data: n.data,
      title: n.title,
      body: n.body,
      status: n.status,
      createdAt: new Date(Date.UTC(2026, 9, 1) + this.clock++ * 1000),
      dedupeKey: n.dedupeKey,
      channel: n.channel,
      eventType: n.eventType,
    });
    return true;
  }

  private own(userId: string) {
    return this.rows.filter((r) => r.recipientUserId === userId && r.channel === NotificationChannel.IN_APP);
  }

  async listForRecipient(userId: string, filter: NotificationListFilter, page: number, size: number) {
    const all = this.own(userId)
      .filter((r) =>
        filter.unread === undefined ? true : filter.unread ? r.status !== NotificationStatus.READ : r.status === NotificationStatus.READ,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: all.slice((page - 1) * size, page * size), total: all.length };
  }

  async countUnread(userId: string) {
    return this.own(userId).filter((r) => r.status !== NotificationStatus.READ).length;
  }

  async findForRecipient(id: string, userId: string) {
    return this.own(userId).find((r) => r.id === id) ?? null;
  }

  async markRead(id: string, userId: string) {
    const row = this.own(userId).find((r) => r.id === id);
    if (row) row.status = NotificationStatus.READ;
  }

  async markAllRead(userId: string) {
    const unread = this.own(userId).filter((r) => r.status !== NotificationStatus.READ);
    unread.forEach((r) => (r.status = NotificationStatus.READ));
    return unread.length;
  }
}

describe('Notifications (application)', () => {
  const ALICE = 'user-alice';
  const BOB = 'user-bob';
  let repo: InMemoryNotificationRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let record: RecordNotificationCommand;

  const languagePort: IIdentityLanguageReadPort = {
    preferredLanguageOf: async (userId) => languages[userId] ?? null,
  };

  beforeEach(() => {
    repo = new InMemoryNotificationRepository();
    languages = { [ALICE]: PreferredLanguage.en, [BOB]: PreferredLanguage.am };
    record = new RecordNotificationCommand(repo, languagePort);
  });

  const decision = { userId: ALICE, organizationId: 'org-1', verificationRequestId: 'vr-1', verificationType: 'PHARMACY_LICENSE', reviewerId: 'admin-1' };

  // -------------------------------------------------------------------------------------------
  // Event → notification
  // -------------------------------------------------------------------------------------------

  describe('event mapping', () => {
    it.each([
      [
        'identity.provider.approved',
        EventNotifications.providerApproved(decision),
        NotificationTemplateCode.PROVIDER_VERIFICATION_APPROVED,
        { verificationRequestId: 'vr-1', verificationType: 'PHARMACY_LICENSE' },
      ],
      [
        'identity.provider.rejected',
        EventNotifications.providerRejected({ ...decision, reason: 'Licence photo unreadable' }),
        NotificationTemplateCode.PROVIDER_VERIFICATION_REJECTED,
        { verificationRequestId: 'vr-1', verificationType: 'PHARMACY_LICENSE', reason: 'Licence photo unreadable' },
      ],
      [
        'identity.license.expired',
        EventNotifications.licenseExpired({
          userId: ALICE,
          organizationId: 'org-1',
          verificationRequestId: 'vr-1',
          verificationType: 'PHARMACY_LICENSE',
          expiredAt: '2026-10-01T00:00:00.000Z',
        }),
        NotificationTemplateCode.PROVIDER_LICENSE_EXPIRED,
        { verificationRequestId: 'vr-1', verificationType: 'PHARMACY_LICENSE', expiredAt: '2026-10-01T00:00:00.000Z' },
      ],
      [
        'identity.account.suspended',
        EventNotifications.accountSuspended({ userId: ALICE, actorUserId: 'admin-1', reason: 'internal note' }),
        NotificationTemplateCode.ACCOUNT_SUSPENDED,
        {},
      ],
      [
        'identity.account.reactivated',
        EventNotifications.accountReactivated({ userId: ALICE, actorUserId: 'admin-1' }),
        NotificationTemplateCode.ACCOUNT_REACTIVATED,
        {},
      ],
      [
        'order.placed',
        EventNotifications.orderPlaced({ orderId: 'o-1', customerUserId: ALICE, totals: { grandTotal: 125_050, currency: 'ETB' } }),
        NotificationTemplateCode.ORDER_PLACED,
        { orderId: 'o-1', grandTotal: 125_050, currency: 'ETB' },
      ],
    ])('%s → its recipient, template and allow-listed data only', (_type, intent, templateCode, data) => {
      expect(intent).toEqual({ recipientUserId: ALICE, templateCode, data });
      const raw = JSON.stringify(intent);
      for (const leaked of ['admin-1', 'org-1', 'internal note', 'reviewerId', 'actorUserId', 'customerUserId']) {
        expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
      }
    });

    it('builds the dedupe key from the event id and the recipient, and nothing else', () => {
      expect(dedupeKeyFor('evt-1', ALICE)).toBe('evt-1:user-alice');
      expect(dedupeKeyFor('evt-1', BOB)).not.toBe(dedupeKeyFor('evt-1', ALICE));
      expect(dedupeKeyFor('evt-2', ALICE)).not.toBe(dedupeKeyFor('evt-1', ALICE));
    });
  });

  // -------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders every template in English and in Amharic, non-empty and distinct', () => {
      const data = { reason: 'R', grandTotal: 100, currency: 'ETB' };
      for (const code of Object.values(NotificationTemplateCode)) {
        const en = renderNotification(code, 'en', data);
        const am = renderNotification(code, 'am', data);
        expect(en.language).toBe('en');
        expect(am.language).toBe('am');
        for (const t of [en.title, en.body, am.title, am.body]) expect(t.length).toBeGreaterThan(0);
        expect(am.title).not.toBe(en.title);
        expect(am.title).toMatch(/[ሀ-፿]/); // Ethiopic script
        expect(en.title).not.toMatch(/[ሀ-፿]/);
      }
    });

    it.each([[null], [undefined], ['fr'], ['']])('falls back to English for language %p', (language) => {
      const r = renderNotification(NotificationTemplateCode.ACCOUNT_REACTIVATED, language as string | null, {});
      expect(r).toEqual({ language: 'en', title: 'Account reactivated', body: 'Your account is active again.' });
    });

    it('interpolates the order total from minor units, and the rejection reason when present', () => {
      expect(formatMinorUnits(125_050)).toBe('1,250.50');
      expect(renderNotification(NotificationTemplateCode.ORDER_PLACED, 'en', { grandTotal: 125_050, currency: 'ETB' }).body).toBe(
        'We have received your order. Total: 1,250.50 ETB.',
      );
      expect(renderNotification(NotificationTemplateCode.ORDER_PLACED, 'am', { grandTotal: 125_050, currency: 'ETB' }).body).toContain(
        '1,250.50 ETB',
      );
      expect(renderNotification(NotificationTemplateCode.PROVIDER_VERIFICATION_REJECTED, 'en', { reason: 'Blurry' }).body).toBe(
        'Your verification request was not approved. Reason: Blurry',
      );
      expect(renderNotification(NotificationTemplateCode.PROVIDER_VERIFICATION_REJECTED, 'en', { reason: null }).body).toBe(
        'Your verification request was not approved.',
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------------------------

  describe('recording', () => {
    const orderIntent = (userId: string) =>
      EventNotifications.orderPlaced({ orderId: 'o-1', customerUserId: userId, totals: { grandTotal: 5_000, currency: 'ETB' } });

    it('writes one IN_APP notification, SENT, in the recipient’s language, with its category and source type', async () => {
      const result = await record.execute({ eventId: 'evt-1', eventType: 'order.placed', intent: orderIntent(BOB) });
      expect(result).toEqual({ created: true, language: 'am' });
      expect(repo.rows).toHaveLength(1);
      expect(repo.rows[0]).toMatchObject({
        recipientUserId: BOB,
        channel: NotificationChannel.IN_APP,
        status: NotificationStatus.SENT,
        category: NotificationCategory.TRANSACTIONAL,
        templateCode: 'ORDER_PLACED',
        eventType: 'order.placed',
        dedupeKey: 'evt-1:user-bob',
        title: 'ትዕዛዝዎ ደርሶናል',
      });
    });

    it('uses English when Module 01 has no language for the recipient', async () => {
      const result = await record.execute({ eventId: 'evt-1', eventType: 'order.placed', intent: orderIntent('user-unknown') });
      expect(result.language).toBe('en');
      expect(repo.rows[0].title).toBe('Order placed');
    });

    it('records a redelivered event once, and the same event for two recipients twice', async () => {
      const input = { eventId: 'evt-1', eventType: 'order.placed', intent: orderIntent(ALICE) };
      expect((await record.execute(input)).created).toBe(true);
      expect((await record.execute(input)).created).toBe(false);
      expect((await record.execute({ ...input, intent: orderIntent(BOB) })).created).toBe(true);
      expect(repo.rows.map((r) => r.dedupeKey).sort()).toEqual(['evt-1:user-alice', 'evt-1:user-bob']);
    });

    it('fails when the language read fails, writing nothing', async () => {
      const failing = new RecordNotificationCommand(repo, { preferredLanguageOf: () => Promise.reject(new Error('db down')) });
      await expect(failing.execute({ eventId: 'e', eventType: 'order.placed', intent: orderIntent(ALICE) })).rejects.toThrow('db down');
      expect(repo.rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Reading, read state and ownership
  // -------------------------------------------------------------------------------------------

  describe('inbox', () => {
    let list: ListNotificationsQuery;
    let count: GetUnreadCountQuery;
    let markRead: MarkNotificationReadCommand;
    let markAll: MarkAllNotificationsReadCommand;

    beforeEach(async () => {
      list = new ListNotificationsQuery(repo);
      count = new GetUnreadCountQuery(repo);
      markRead = new MarkNotificationReadCommand(repo);
      markAll = new MarkAllNotificationsReadCommand(repo);
      for (let i = 0; i < 3; i += 1) {
        await record.execute({ eventId: `a-${i}`, eventType: 'identity.account.reactivated', intent: EventNotifications.accountReactivated({ userId: ALICE, actorUserId: 'x' }) });
      }
      await record.execute({ eventId: 'b-0', eventType: 'identity.account.reactivated', intent: EventNotifications.accountReactivated({ userId: BOB, actorUserId: 'x' }) });
    });

    it('lists only the recipient’s own notifications, newest first', async () => {
      const page = await list.execute({ recipientUserId: ALICE });
      expect(page.total).toBe(3);
      expect(page.items.every((n) => n.recipientUserId === ALICE)).toBe(true);
      const times = page.items.map((n) => n.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('counts unread, marks one read, and filters by read state', async () => {
      expect(await count.execute(ALICE)).toEqual({ unread: 3 });
      const [first] = (await list.execute({ recipientUserId: ALICE })).items;
      const read = await markRead.execute({ recipientUserId: ALICE, notificationId: first.id });
      expect(read.status).toBe(NotificationStatus.READ);
      expect(await count.execute(ALICE)).toEqual({ unread: 2 });
      expect((await list.execute({ recipientUserId: ALICE, unread: true })).total).toBe(2);
      expect((await list.execute({ recipientUserId: ALICE, unread: false })).items.map((n) => n.id)).toEqual([first.id]);
      // Idempotent.
      expect((await markRead.execute({ recipientUserId: ALICE, notificationId: first.id })).status).toBe(NotificationStatus.READ);
      expect(await count.execute(ALICE)).toEqual({ unread: 2 });
    });

    it('refuses another user’s notification as NOT_FOUND, exactly like an unknown id, and changes nothing', async () => {
      const bobs = (await list.execute({ recipientUserId: BOB })).items[0];
      await expect(markRead.execute({ recipientUserId: ALICE, notificationId: bobs.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(markRead.execute({ recipientUserId: ALICE, notificationId: randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await count.execute(BOB)).toEqual({ unread: 1 });
    });

    it('read-all marks only the caller’s unread notifications, and is idempotent', async () => {
      expect(await markAll.execute(ALICE)).toEqual({ updated: 3 });
      expect(await markAll.execute(ALICE)).toEqual({ updated: 0 });
      expect(await count.execute(ALICE)).toEqual({ unread: 0 });
      expect(await count.execute(BOB)).toEqual({ unread: 1 });
    });

    it('clamps paging', async () => {
      expect(await list.execute({ recipientUserId: ALICE, page: 0, size: 10_000 })).toMatchObject({ page: 1, size: MAX_NOTIFICATION_PAGE_SIZE });
    });

    it('maps a record to an allow-listed response', async () => {
      const [n] = (await list.execute({ recipientUserId: ALICE })).items;
      const res = toNotificationResponse({ ...n, extra: 'x' } as NotificationRecord);
      expect(Object.keys(res).sort()).toEqual(['body', 'category', 'createdAt', 'data', 'id', 'read', 'title', 'type']);
      expect(res.read).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // DTO
  // -------------------------------------------------------------------------------------------

  describe('ListNotificationsQueryDto', () => {
    const errorsFor = (query: Record<string, unknown>) =>
      validateSync(plainToInstance(ListNotificationsQueryDto, query, { enableImplicitConversion: true }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }).map((e) => e.property);

    it('accepts the documented filters', () => {
      expect(errorsFor({})).toEqual([]);
      expect(errorsFor({ unread: 'true', page: '2', size: '100' })).toEqual([]);
      expect(errorsFor({ unread: 'false' })).toEqual([]);
    });

    it.each([
      [{ unread: 'yes' }, 'unread'],
      [{ page: '0' }, 'page'],
      [{ size: '101' }, 'size'],
      [{ recipientUserId: ALICE }, 'recipientUserId'],
      [{ actorUserId: ALICE }, 'actorUserId'],
      [{ userId: ALICE }, 'userId'],
    ])('rejects %p', (query, property) => {
      expect(errorsFor(query)).toContain(property);
    });
  });
});
