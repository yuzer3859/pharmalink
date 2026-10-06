import { randomUUID } from 'crypto';
import { IDriverRecipientReadPort } from '../../delivery/application/ports/inbound/driver-recipient-read.port';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordDriverNotificationCommand } from './commands/record-driver-notification.command';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { DriverNotifications, NotificationIntent } from './support/event-notifications';

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
 * Module 13 Work 05's application layer, with Modules 01 and 08 behind fake ports. Each driver
 * event resolves its person through the driver profile; the rest is Work 01's write, unchanged.
 */
describe('Driver notifications (application)', () => {
  const PROFILE = 'driver-profile-1';
  const DRIVER_USER = 'driver-user-1';
  const common = {
    jobId: 'job-1',
    orderId: 'order-secret-1',
    fulfillmentId: 'ful-secret-1',
    driverId: PROFILE,
  };
  const offered = { ...common, offerId: 'offer-secret-1', round: 2, expiresAt: '2026-10-06T10:05:00.000Z' };
  const earning = { ...common, earningId: 'earn-secret-1', amount: 8_550, currency: 'ETB', calculationVersion: 'rate-card-v3' };
  const cod = {
    ...common,
    collectionId: 'coll-secret-1',
    expectedAmount: 48_000,
    collectedAmount: 47_000,
    currency: 'ETB',
    method: 'ELECTRONIC',
    providerReference: 'TELEBIRR-TXN-998',
  };
  const remitted = {
    ...cod,
    remittanceId: 'rem-secret-1',
    remittedAmount: 46_500,
    reference: 'CASHDESK-2026-10-06',
    confirmedByUserId: 'operator-secret-1',
    remittedAt: '2026-10-06T12:00:00.000Z',
  };
  const reconciled = (outcome: string) => ({
    ...cod,
    reconciliationId: 'recon-secret-1',
    remittedAmount: 46_500,
    remittanceReference: 'CASHDESK-2026-10-06',
    reconciliationReference: 'RECON-01',
    outcome,
    reconciledByUserId: 'operator-secret-2',
    reconciledAt: '2026-10-06T13:00:00.000Z',
  });
  const correction = {
    ...common,
    correctionId: 'corr-secret-1',
    collectionId: 'coll-secret-1',
    remittanceId: null,
    reconciliationId: 'recon-secret-1',
    type: 'RECORDING_MISTAKE',
    originalAmount: 47_000,
    correctedAmount: 48_000,
    originalReference: null,
    correctedReference: null,
    currency: 'ETB',
    reason: 'Cash desk recount after supervisor review #4471',
    createdByUserId: 'operator-secret-3',
    createdAt: '2026-10-06T14:00:00.000Z',
  };

  type Case = [string, { driverId: string }, (p: never, u: string) => NotificationIntent, NotificationTemplateCode, Record<string, unknown>, string];
  const cases: Case[] = [
    ['delivery.job.offered', offered, DriverNotifications.jobOffered, NotificationTemplateCode.DRIVER_JOB_OFFERED, { jobId: 'job-1', expiresAt: '2026-10-06T10:05:00.000Z' }, 'New delivery offer'],
    ['delivery.earning.accrued', earning, DriverNotifications.earningAccrued, NotificationTemplateCode.DRIVER_EARNING_ACCRUED, { jobId: 'job-1', amount: 8_550, currency: 'ETB' }, 'Earning recorded'],
    [
      'delivery.cod.remitted',
      remitted,
      DriverNotifications.codRemitted,
      NotificationTemplateCode.DRIVER_COD_REMITTED,
      { jobId: 'job-1', remittedAmount: 46_500, currency: 'ETB', reference: 'CASHDESK-2026-10-06' },
      'Cash handover confirmed',
    ],
    ['delivery.cod.reconciled', reconciled('ACCEPTED'), DriverNotifications.codReconciled, NotificationTemplateCode.DRIVER_COD_RECONCILED, { jobId: 'job-1', outcome: 'ACCEPTED' }, 'Cash-on-delivery reconciled'],
    [
      'delivery.cod.correction_recorded',
      correction,
      DriverNotifications.codCorrectionRecorded,
      NotificationTemplateCode.DRIVER_COD_CORRECTION_RECORDED,
      { jobId: 'job-1', correctionType: 'RECORDING_MISTAKE' },
      'Cash-on-delivery record corrected',
    ],
  ];

  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let profiles: Record<string, string>;
  let lookups: string[];
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordDriverNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [DRIVER_USER]: PreferredLanguage.en };
    profiles = { [PROFILE]: DRIVER_USER };
    lookups = [];
    logger = fakeLogger();
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort);
    const drivers: IDriverRecipientReadPort = {
      userIdOf: async (id) => {
        lookups.push(id);
        return profiles[id] ?? null;
      },
    };
    command = new RecordDriverNotificationCommand(drivers, record, logger);
  });

  const run = (c: Case, eventId = randomUUID()) =>
    command.execute({ eventId, eventType: c[0], payload: c[1], toIntent: c[2] as never });

  // -------------------------------------------------------------------------------------------
  // Each event: recipient, template, allow-listed data
  // -------------------------------------------------------------------------------------------

  it.each(cases)('%s → the profile’s user, the right template, approved fields only', async (...c) => {
    const [eventType, , , templateCode, data, title] = c;
    const eventId = randomUUID();
    expect(await run(c, eventId)).toEqual({ created: true, language: 'en' });
    expect(lookups).toEqual([PROFILE]);
    expect(repo.rows).toEqual([
      {
        recipientUserId: DRIVER_USER,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${DRIVER_USER}`,
        data,
        title,
        body: expect.any(String),
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it.each(cases)('%s leaks no internal id, operator, provider reference, rate card or operator note', async (...c) => {
    await run(c);
    const raw = JSON.stringify(repo.rows[0]);
    for (const leaked of [
      PROFILE, 'driverId', 'order-secret-1', 'ful-secret-1', 'offer-secret-1', 'earn-secret-1', 'coll-secret-1',
      'rem-secret-1', 'recon-secret-1', 'corr-secret-1', 'operator-secret', 'TELEBIRR-TXN-998', 'rate-card-v3',
      'supervisor review', '#4471', 'ELECTRONIC', 'expectedAmount', 'collectedAmount', 'originalAmount', 'correctedAmount',
    ]) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  // -------------------------------------------------------------------------------------------
  // Semantics
  // -------------------------------------------------------------------------------------------

  it('an offer asks for action before it expires, carries the deadline as data, and invents no clock time', async () => {
    await run(cases[0]);
    expect(repo.rows[0].body).toBe('You have a new delivery job offer. Accept or decline it before it expires.');
    expect(repo.rows[0].data).toEqual({ jobId: 'job-1', expiresAt: '2026-10-06T10:05:00.000Z' });
    expect(repo.rows[0].body).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('an earning is recorded, never paid, transferred or guaranteed', async () => {
    await run(cases[1]);
    expect(repo.rows[0].body).toBe('An earning of 85.50 ETB has been recorded for your delivery.');
    expect(repo.rows[0].body).not.toMatch(/paid|transfer|guarantee|payout/i);
  });

  it('a remittance is PharmaLink receiving the cash handed over — never the driver’s income', async () => {
    await run(cases[2]);
    const { body } = repo.rows[0];
    expect(body).toBe('PharmaLink has confirmed receiving the 465.00 ETB cash-on-delivery payment you handed over for this delivery.');
    expect(body).not.toMatch(/earn|income|paid you|your money|revenue/i);
  });

  it('a reconciliation states the finding only, with no amounts and no consequence', async () => {
    expect(renderNotification(NotificationTemplateCode.DRIVER_COD_RECONCILED, 'en', { outcome: 'ACCEPTED' }).body).toBe(
      'The cash-on-delivery amounts for this delivery have been checked and agree.',
    );
    const diff = renderNotification(NotificationTemplateCode.DRIVER_COD_RECONCILED, 'en', { outcome: 'DISCREPANCY' }).body;
    expect(diff).toBe('The cash-on-delivery amounts for this delivery have been checked and a difference was recorded.');
    expect(diff).not.toMatch(/recover|deduct|owe|withh|penalt|\d/i);
  });

  it('a correction says one was recorded, and nothing of its figures, references or reason', async () => {
    await run(cases[4]);
    expect(repo.rows[0].body).toBe('A correction has been recorded to the cash-on-delivery record for this delivery.');
    expect(repo.rows[0].body).not.toMatch(/\d/);
  });

  // -------------------------------------------------------------------------------------------
  // Language
  // -------------------------------------------------------------------------------------------

  it('renders in Amharic for an Amharic-speaking driver', async () => {
    languages[DRIVER_USER] = PreferredLanguage.am;
    expect(await run(cases[1])).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ገቢ ተመዝግቧል', body: 'ለማድረስ ሥራዎ 85.50 ETB ገቢ ተመዝግቧል።' });
  });

  it.each([[null], [undefined], ['so']])('falls back to English for language %p', async (language) => {
    languages[DRIVER_USER] = language as PreferredLanguage | null;
    expect((await run(cases[0])).created).toBe(true);
    expect(repo.rows[0].title).toBe('New delivery offer');
  });

  it('renders every driver template in both languages, Amharic in Ethiopic script', () => {
    const data = { amount: 100, remittedAmount: 100, currency: 'ETB', outcome: 'DISCREPANCY' };
    for (const [, , , code] of cases) {
      const en = renderNotification(code, 'en', data);
      const am = renderNotification(code, 'am', data);
      expect(en.title.length * en.body.length * am.title.length * am.body.length).toBeGreaterThan(0);
      expect(am.title).toMatch(/[ሀ-፿]/);
      expect(en.title).not.toMatch(/[ሀ-፿]/);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Missing driver, dedupe
  // -------------------------------------------------------------------------------------------

  it.each(cases)('%s for an unknown driver profile writes nothing, invents no recipient, and warns', async (...c) => {
    delete profiles[PROFILE];
    expect(await run(c)).toEqual({ created: false, reason: 'DRIVER_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining(`driver profile ${PROFILE} not found`)]);
  });

  it.each(cases)('%s redelivered is recorded once, keyed eventId:driverUserId', async (...c) => {
    const eventId = randomUUID();
    expect((await run(c, eventId)).created).toBe(true);
    expect((await run(c, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${DRIVER_USER}`]);
  });

  it('passes a driver-lookup failure through and writes nothing', async () => {
    const failing = new RecordDriverNotificationCommand(
      { userIdOf: () => Promise.reject(new Error('db down')) },
      new RecordNotificationCommand(repo as unknown as INotificationRepository, { preferredLanguageOf: async () => null }),
      logger,
    );
    await expect(
      failing.execute({ eventId: 'e', eventType: 'delivery.job.offered', payload: offered, toIntent: DriverNotifications.jobOffered }),
    ).rejects.toThrow('db down');
    expect(repo.rows).toEqual([]);
  });
});
