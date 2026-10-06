import { randomUUID } from 'crypto';
import { IDriverRecipientReadPort } from '../../delivery/application/ports/inbound/driver-recipient-read.port';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordDriverNotificationCommand } from './commands/record-driver-notification.command';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { DriverNotifications } from './support/event-notifications';

class RecordingRepository implements Pick<INotificationRepository, 'insertIfAbsent'> {
  rows: NewNotification[] = [];
  async insertIfAbsent(n: NewNotification): Promise<boolean> {
    if (this.rows.some((r) => r.dedupeKey === n.dedupeKey)) return false;
    this.rows.push(n);
    return true;
  }
}

function fakeLogger(): AppLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    setContext: () => undefined,
    log: () => undefined,
    warn: (m: string) => warnings.push(m),
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  } as unknown as AppLogger & { warnings: string[] };
}

/**
 * Module 13 Work 09: `delivery.job.assigned` on Work 05's driver path, with Modules 01 and 08
 * behind fake ports. The assignment is its own notification, distinct from the offer.
 */
describe('Driver job-assigned notification (application)', () => {
  const PROFILE = 'driver-profile-1';
  const DRIVER_USER = 'driver-user-1';
  const assigned = { jobId: 'job-1', offerId: 'offer-secret-1', orderId: 'order-secret-1', driverId: PROFILE };
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let profiles: Record<string, string>;
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordDriverNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [DRIVER_USER]: PreferredLanguage.en };
    profiles = { [PROFILE]: DRIVER_USER };
    logger = fakeLogger();
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort);
    const drivers: IDriverRecipientReadPort = { userIdOf: async (id) => profiles[id] ?? null };
    command = new RecordDriverNotificationCommand(drivers, record, logger);
  });

  const assign = (eventId = randomUUID(), payload = assigned) =>
    command.execute({ eventId, eventType: 'delivery.job.assigned', payload, toIntent: DriverNotifications.jobAssigned });
  const offer = (eventId = randomUUID()) =>
    command.execute({
      eventId,
      eventType: 'delivery.job.offered',
      payload: { ...assigned, round: 1, expiresAt: '2026-10-07T10:00:00.000Z' },
      toIntent: DriverNotifications.jobOffered,
    });

  it('→ one notification for the profile’s user, DRIVER_JOB_ASSIGNED, { jobId } only', async () => {
    const eventId = randomUUID();
    expect(await assign(eventId)).toEqual({ created: true, language: 'en' });
    expect(repo.rows).toEqual([
      {
        recipientUserId: DRIVER_USER,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode: NotificationTemplateCode.DRIVER_JOB_ASSIGNED,
        eventType: 'delivery.job.assigned',
        dedupeKey: `${eventId}:${DRIVER_USER}`,
        data: { jobId: 'job-1' },
        title: 'Delivery job assigned',
        body: 'This delivery job is now assigned to you.',
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it('keeps no offer, order or driver-profile id, and nothing a careless producer might add', async () => {
    await assign(randomUUID(), {
      ...assigned,
      customerPhone: '+251911000999',
      plateNumber: 'AA-12345',
      lat: 9.02,
      codAmount: 48_000,
    } as typeof assigned);
    expect(Object.keys(repo.rows[0].data)).toEqual(['jobId']);
    const raw = JSON.stringify(repo.rows[0]);
    for (const leaked of [PROFILE, 'driverId', 'offer-secret-1', 'order-secret-1', '+251911000999', 'AA-12345', 'codAmount', '"lat"']) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  it('says the job is assigned — no pickup, ETA, earning, payment or COD claim, and not the offer’s wording', () => {
    const offerText = renderNotification(NotificationTemplateCode.DRIVER_JOB_OFFERED, 'en', {});
    for (const language of ['en', 'am'] as const) {
      const r = renderNotification(NotificationTemplateCode.DRIVER_JOB_ASSIGNED, language, {});
      expect(`${r.title} ${r.body}`).not.toMatch(/pick|picked|eta|minute|earn|paid|payment|cash|cod|deliver(ed)? to|accept or decline|expire/i);
      expect(r.title).not.toBe(renderNotification(NotificationTemplateCode.DRIVER_JOB_OFFERED, language, {}).title);
    }
    expect(offerText.body).toContain('Accept or decline');
  });

  it('renders in Amharic for an Amharic-speaking driver', async () => {
    languages[DRIVER_USER] = PreferredLanguage.am;
    expect(await assign()).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'የማድረስ ሥራ ተመድቦልዎታል', body: 'ይህ የማድረስ ሥራ አሁን ለእርስዎ ተመድቧል።' });
  });

  it.each([[null], [undefined], ['sw']])('falls back to English for language %p', async (language) => {
    languages[DRIVER_USER] = language as PreferredLanguage | null;
    expect(await assign()).toEqual({ created: true, language: 'en' });
    expect(repo.rows[0].title).toBe('Delivery job assigned');
  });

  it('an unknown driver profile writes nothing, invents no recipient, and warns', async () => {
    delete profiles[PROFILE];
    expect(await assign()).toEqual({ created: false, reason: 'DRIVER_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining(`driver profile ${PROFILE} not found`)]);
  });

  it('a redelivered assignment is recorded once, keyed eventId:driverUserId', async () => {
    const eventId = randomUUID();
    expect((await assign(eventId)).created).toBe(true);
    expect((await assign(eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${DRIVER_USER}`]);
  });

  it('the offer and the assignment of the same job are two notifications, not deduplicated together', async () => {
    await offer();
    await assign();
    expect(repo.rows.map((r) => [r.templateCode, r.data.jobId])).toEqual([
      ['DRIVER_JOB_OFFERED', 'job-1'],
      ['DRIVER_JOB_ASSIGNED', 'job-1'],
    ]);
    expect(new Set(repo.rows.map((r) => r.dedupeKey)).size).toBe(2);
  });
});
