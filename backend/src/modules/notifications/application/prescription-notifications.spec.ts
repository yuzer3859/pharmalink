import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { IPrescriptionRecipientReadPort } from '../../prescription-matching/application/ports/inbound/prescription-recipient-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { PrescriptionSubject, RecordPrescriptionNotificationCommand } from './commands/record-prescription-notification.command';
import { NotificationIntent, PrescriptionNotifications } from './support/event-notifications';

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
 * Module 13 Work 06's application layer, with Modules 01 and 05 behind fake ports. The customer is
 * the prescription's or match request's owner as Module 05 answers it; nothing medical is kept.
 */
describe('Prescription & matching notifications (application)', () => {
  const CUSTOMER = 'customer-a';
  const PRESCRIPTION = 'rx-1';
  const MATCH = 'match-1';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let prescriptionOwners: Record<string, string>;
  let matchOwners: Record<string, string>;
  let asked: string[];
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordPrescriptionNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [CUSTOMER]: PreferredLanguage.en };
    prescriptionOwners = { [PRESCRIPTION]: CUSTOMER };
    matchOwners = { [MATCH]: CUSTOMER };
    asked = [];
    logger = fakeLogger();
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort);
    const port: IPrescriptionRecipientReadPort = {
      customerUserIdOfPrescription: async (id) => {
        asked.push(`rx:${id}`);
        return prescriptionOwners[id] ?? null;
      },
      customerUserIdOfMatchRequest: async (id) => {
        asked.push(`match:${id}`);
        return matchOwners[id] ?? null;
      },
    };
    command = new RecordPrescriptionNotificationCommand(port, record, logger);
  });

  // An approval carries medical lines; a rejection a pharmacist's note.
  const approved = {
    prescriptionId: PRESCRIPTION,
    lines: [{ lineId: 'line-1', catalogProductId: 'product-amoxicillin', approvedQuantity: 21 }],
  };
  const rejected = { prescriptionId: PRESCRIPTION, reason: 'Prescription is older than 30 days' };
  const failed = { matchRequestId: MATCH };

  type Case = [string, object, PrescriptionSubject, (p: never, c: string) => NotificationIntent, NotificationTemplateCode, Record<string, unknown>, string, string];
  const cases: Case[] = [
    ['prescription.approved', approved, { kind: 'prescription', id: PRESCRIPTION }, PrescriptionNotifications.prescriptionApproved, NotificationTemplateCode.PRESCRIPTION_APPROVED, { prescriptionId: PRESCRIPTION }, `rx:${PRESCRIPTION}`, 'Prescription approved'],
    [
      'prescription.rejected',
      rejected,
      { kind: 'prescription', id: PRESCRIPTION },
      PrescriptionNotifications.prescriptionRejected,
      NotificationTemplateCode.PRESCRIPTION_REJECTED,
      { prescriptionId: PRESCRIPTION, reason: 'Prescription is older than 30 days' },
      `rx:${PRESCRIPTION}`,
      'Prescription not approved',
    ],
    ['matching.match_failed', failed, { kind: 'matchRequest', id: MATCH }, PrescriptionNotifications.matchFailed, NotificationTemplateCode.MATCHING_FAILED, { matchRequestId: MATCH }, `match:${MATCH}`, 'No pharmacy found'],
  ];

  const run = (c: Case, eventId = randomUUID()) =>
    command.execute({ eventId, eventType: c[0], payload: c[1], subject: c[2], toIntent: c[3] as never });

  // -------------------------------------------------------------------------------------------
  // Each event
  // -------------------------------------------------------------------------------------------

  it.each(cases)('%s → the owner Module 05 names, the right template, approved fields only', async (...c) => {
    const [eventType, , , , templateCode, data, lookup, title] = c;
    const eventId = randomUUID();
    expect(await run(c, eventId)).toEqual({ created: true, language: 'en' });
    expect(asked).toEqual([lookup]);
    expect(repo.rows).toEqual([
      {
        recipientUserId: CUSTOMER,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${CUSTOMER}`,
        data,
        title,
        body: expect.any(String),
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it('keeps no medical line, product or quantity from an approval', async () => {
    await run(cases[0]);
    // The quantity is asserted through the data keys: bare digits could occur in the random dedupe key.
    expect(Object.keys(repo.rows[0].data)).toEqual(['prescriptionId']);
    const raw = JSON.stringify(repo.rows[0]);
    for (const leaked of ['lines', 'line-1', 'product-amoxicillin', 'catalogProductId', 'approvedQuantity']) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  it('keeps the pharmacist’s rejection reason in data only — never in the title or body', async () => {
    await run(cases[1]);
    const [n] = repo.rows;
    expect(n.data.reason).toBe('Prescription is older than 30 days');
    expect(`${n.title} ${n.body}`).not.toContain('30 days');
    expect(n.body).toBe('Your prescription was not approved after review.');
  });

  it('states a failed match without naming a pharmacy, stock or reason', async () => {
    await run(cases[2]);
    expect(repo.rows[0].body).toBe('We could not find a pharmacy able to fulfil your request.');
    expect(Object.keys(repo.rows[0].data)).toEqual(['matchRequestId']);
  });

  it.each(cases)('%s title and body carry no medicine, quantity, diagnosis or prescriber wording', async (...c) => {
    for (const language of ['en', 'am'] as const) {
      const r = renderNotification(c[4], language, c[5] as Record<string, string>);
      expect(`${r.title} ${r.body}`).not.toMatch(/amoxicillin|mg\b|tablet|dose|diagnos|doctor|\d/i);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Language
  // -------------------------------------------------------------------------------------------

  it('renders in Amharic for an Amharic-speaking customer', async () => {
    languages[CUSTOMER] = PreferredLanguage.am;
    expect(await run(cases[0])).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'የሐኪም ማዘዣዎ ጸድቋል', body: 'የሐኪም ማዘዣዎ በፋርማሲስት ተገምግሞ ጸድቋል።' });
  });

  it.each([[null], [undefined], ['ti']])('falls back to English for language %p', async (language) => {
    languages[CUSTOMER] = language as PreferredLanguage | null;
    expect((await run(cases[2])).created).toBe(true);
    expect(repo.rows[0].title).toBe('No pharmacy found');
  });

  it('renders every new template in both languages, Amharic in Ethiopic script', () => {
    for (const [, , , , code] of cases) {
      const en = renderNotification(code, 'en', {});
      const am = renderNotification(code, 'am', {});
      expect(en.title.length * en.body.length * am.title.length * am.body.length).toBeGreaterThan(0);
      expect(am.title).toMatch(/[ሀ-፿]/);
      expect(en.title).not.toMatch(/[ሀ-፿]/);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Missing subject, dedupe
  // -------------------------------------------------------------------------------------------

  it.each([
    [cases[0], 'PRESCRIPTION_NOT_FOUND', `prescription ${PRESCRIPTION} not found`],
    [cases[1], 'PRESCRIPTION_NOT_FOUND', `prescription ${PRESCRIPTION} not found`],
    [cases[2], 'MATCH_REQUEST_NOT_FOUND', `match request ${MATCH} not found`],
  ] as const)('%s for an unknown subject writes nothing, invents no recipient, and warns', async (c, reason, warning) => {
    delete prescriptionOwners[PRESCRIPTION];
    delete matchOwners[MATCH];
    expect(await run(c)).toEqual({ created: false, reason });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining(warning)]);
  });

  it.each(cases)('%s redelivered is recorded once, keyed eventId:customerUserId', async (...c) => {
    const eventId = randomUUID();
    expect((await run(c, eventId)).created).toBe(true);
    expect((await run(c, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${CUSTOMER}`]);
  });

  it('passes a recipient-lookup failure through and writes nothing', async () => {
    const failing = new RecordPrescriptionNotificationCommand(
      {
        customerUserIdOfPrescription: () => Promise.reject(new Error('db down')),
        customerUserIdOfMatchRequest: () => Promise.reject(new Error('db down')),
      },
      new RecordNotificationCommand(repo as unknown as INotificationRepository, { preferredLanguageOf: async () => null }),
      logger,
    );
    await expect(
      failing.execute({
        eventId: 'e',
        eventType: 'prescription.approved',
        payload: approved,
        subject: { kind: 'prescription', id: PRESCRIPTION },
        toIntent: PrescriptionNotifications.prescriptionApproved,
      }),
    ).rejects.toThrow('db down');
    expect(repo.rows).toEqual([]);
  });
});
