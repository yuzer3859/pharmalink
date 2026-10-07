import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { IPharmacyRecipientReadPort } from '../../pharmacy-inventory/application/ports/inbound/pharmacy-recipient-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { RecordPharmacyNotificationCommand } from './commands/record-pharmacy-notification.command';
import { NotificationIntent, PharmacyNotifications } from './support/event-notifications';

/** Work 13: no stored preference — every external channel at its default. */
const NO_STORED_PREFERENCES = { listForUser: async () => [], upsert: async () => undefined };

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
 * Module 13 Work 07's application layer, with Modules 01 and 04 behind fake ports. The one
 * recipient is the pharmacy's organization owner as Module 04 answers it.
 */
describe('Pharmacy notifications (application)', () => {
  const PHARMACY = 'pharmacy-1';
  const OWNER = 'owner-user-1';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let owners: Record<string, string>;
  let asked: string[];
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordPharmacyNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [OWNER]: PreferredLanguage.en };
    owners = { [PHARMACY]: OWNER };
    asked = [];
    logger = fakeLogger();
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort, NO_STORED_PREFERENCES);
    const port: IPharmacyRecipientReadPort = {
      ownerUserIdOfPharmacy: async (id) => {
        asked.push(id);
        return owners[id] ?? null;
      },
    };
    command = new RecordPharmacyNotificationCommand(port, record, logger);
  });

  const activated = { pharmacyId: PHARMACY, organizationId: 'org-secret-1' };
  const suspended = (reason: 'LICENSE_EXPIRED' | 'MANUAL') => ({ pharmacyId: PHARMACY, reason });

  type Case = [string, { pharmacyId: string }, (p: never, u: string) => NotificationIntent, NotificationTemplateCode, Record<string, unknown>, string, string];
  const cases: Case[] = [
    ['pharmacy.pharmacy.activated', activated, PharmacyNotifications.pharmacyActivated, NotificationTemplateCode.PHARMACY_ACTIVATED, { pharmacyId: PHARMACY }, 'Pharmacy activated', 'Your pharmacy has been activated on PharmaLink.'],
    [
      'pharmacy.pharmacy.suspended',
      suspended('LICENSE_EXPIRED'),
      PharmacyNotifications.pharmacySuspended,
      NotificationTemplateCode.PHARMACY_SUSPENDED,
      { pharmacyId: PHARMACY, reason: 'LICENSE_EXPIRED' },
      'Pharmacy suspended',
      'Your pharmacy has been suspended because its licence has expired.',
    ],
  ];

  const run = (c: Case, eventId = randomUUID()) =>
    command.execute({ eventId, eventType: c[0], payload: c[1], toIntent: c[2] as never });

  it.each(cases)('%s → the pharmacy’s owner, the right template, approved fields only', async (...c) => {
    const [eventType, , , templateCode, data, title, bodyText] = c;
    const eventId = randomUUID();
    expect(await run(c, eventId)).toEqual({ created: true, language: 'en' });
    expect(asked).toEqual([PHARMACY]);
    expect(repo.rows).toEqual([
      {
        recipientUserId: OWNER,
        category: NotificationCategory.SYSTEM,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${OWNER}`,
        data,
        title,
        body: bodyText,
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it('keeps no organization id, and nothing beyond the pharmacy reference and reason code', async () => {
    await run(cases[0]);
    expect(JSON.stringify(repo.rows[0])).not.toContain('org-secret-1');
    expect(Object.keys(repo.rows[0].data)).toEqual(['pharmacyId']);
  });

  it('words a manual suspension generically, giving no cause it does not know', () => {
    expect(renderNotification(NotificationTemplateCode.PHARMACY_SUSPENDED, 'en', suspended('MANUAL')).body).toBe('Your pharmacy has been suspended.');
    expect(renderNotification(NotificationTemplateCode.PHARMACY_SUSPENDED, 'am', suspended('MANUAL')).body).toBe('ፋርማሲዎ ታግዷል።');
  });

  it('renders in Amharic for an Amharic-speaking owner', async () => {
    languages[OWNER] = PreferredLanguage.am;
    expect(await run(cases[1])).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ፋርማሲዎ ታግዷል', body: 'የፈቃዱ ጊዜ ስላለፈ ፋርማሲዎ ታግዷል።' });
  });

  it.each([[null], [undefined], ['om']])('falls back to English for language %p', async (language) => {
    languages[OWNER] = language as PreferredLanguage | null;
    expect((await run(cases[0])).created).toBe(true);
    expect(repo.rows[0].title).toBe('Pharmacy activated');
  });

  it('renders both templates in both languages, Amharic in Ethiopic script', () => {
    for (const [, payload, , code] of cases) {
      const en = renderNotification(code, 'en', payload as Record<string, string>);
      const am = renderNotification(code, 'am', payload as Record<string, string>);
      expect(en.title.length * en.body.length * am.title.length * am.body.length).toBeGreaterThan(0);
      expect(am.title).toMatch(/[ሀ-፿]/);
      expect(en.title).not.toMatch(/[ሀ-፿]/);
    }
  });

  it.each(cases)('%s for an unknown pharmacy or owner writes nothing, invents no recipient, and warns', async (...c) => {
    delete owners[PHARMACY];
    expect(await run(c)).toEqual({ created: false, reason: 'PHARMACY_OWNER_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining(`owner of pharmacy ${PHARMACY} not found`)]);
  });

  it.each(cases)('%s redelivered is recorded once, keyed eventId:ownerUserId', async (...c) => {
    const eventId = randomUUID();
    expect((await run(c, eventId)).created).toBe(true);
    expect((await run(c, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${OWNER}`]);
  });

  it('passes an owner-lookup failure through and writes nothing', async () => {
    const failing = new RecordPharmacyNotificationCommand(
      { ownerUserIdOfPharmacy: () => Promise.reject(new Error('db down')) },
      new RecordNotificationCommand(repo as unknown as INotificationRepository, { preferredLanguageOf: async () => null }, NO_STORED_PREFERENCES),
      logger,
    );
    await expect(
      failing.execute({ eventId: 'e', eventType: 'pharmacy.pharmacy.activated', payload: activated, toIntent: PharmacyNotifications.pharmacyActivated }),
    ).rejects.toThrow('db down');
    expect(repo.rows).toEqual([]);
  });
});
