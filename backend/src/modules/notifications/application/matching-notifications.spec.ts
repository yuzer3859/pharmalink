import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { IPrescriptionRecipientReadPort } from '../../prescription-matching/application/ports/inbound/prescription-recipient-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { RecordPrescriptionNotificationCommand } from './commands/record-prescription-notification.command';
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
 * Module 13 Work 10: `matching.order_matched` and `matching.rematch_triggered` to the match
 * request's customer, on Work 06's path and port, with Modules 01 and 05 behind fakes.
 */
describe('Matching outcome notifications (application)', () => {
  const CUSTOMER = 'customer-a';
  const MATCH = 'match-1';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let matchOwners: Record<string, string>;
  let asked: string[];
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordPrescriptionNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [CUSTOMER]: PreferredLanguage.en };
    matchOwners = { [MATCH]: CUSTOMER };
    asked = [];
    logger = fakeLogger();
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort);
    const port: IPrescriptionRecipientReadPort = {
      customerUserIdOfPrescription: async () => {
        throw new Error('matching events resolve through the match request');
      },
      customerUserIdOfMatchRequest: async (id) => {
        asked.push(id);
        return matchOwners[id] ?? null;
      },
    };
    command = new RecordPrescriptionNotificationCommand(port, record, logger);
  });

  // The real payload shapes, with the internal detail a careless mapping could leak.
  const matched = {
    matchRequestId: MATCH,
    orderId: null,
    result: {
      pharmacyId: 'pharmacy-secret-1',
      branchId: 'branch-secret-1',
      lines: [{ catalogProductId: 'product-amoxicillin', listingId: 'listing-secret-1', reservationId: 'res-secret-1', quantity: 21 }],
    },
  };
  const rematched = { matchRequestId: MATCH, excludedPharmacyId: 'pharmacy-excluded-secret' };

  type Case = [string, object, (p: never, c: string) => NotificationIntent, NotificationTemplateCode, string, string];
  const cases: Case[] = [
    ['matching.order_matched', matched, PrescriptionNotifications.orderMatched, NotificationTemplateCode.MATCHING_ORDER_MATCHED, 'Pharmacy found', 'We found a pharmacy that can fulfil your request.'],
    [
      'matching.rematch_triggered',
      rematched,
      PrescriptionNotifications.rematchTriggered,
      NotificationTemplateCode.MATCHING_REMATCH_TRIGGERED,
      'Moved to another pharmacy',
      'Your request has been moved to another pharmacy.',
    ],
  ];

  const run = (c: Case, eventId = randomUUID()) =>
    command.execute({ eventId, eventType: c[0], payload: c[1], subject: { kind: 'matchRequest', id: MATCH }, toIntent: c[2] as never });

  it.each(cases)('%s → the match request’s customer, the right template, { matchRequestId } only', async (...c) => {
    const [eventType, , , templateCode, title, body] = c;
    const eventId = randomUUID();
    expect(await run(c, eventId)).toEqual({ created: true, language: 'en' });
    expect(asked).toEqual([MATCH]);
    expect(repo.rows).toEqual([
      {
        recipientUserId: CUSTOMER,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${CUSTOMER}`,
        data: { matchRequestId: MATCH },
        title,
        body,
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it.each(cases)('%s keeps no pharmacy, branch, listing, reservation, product, quantity or excluded pharmacy', async (...c) => {
    await run(c);
    expect(Object.keys(repo.rows[0].data)).toEqual(['matchRequestId']);
    const raw = JSON.stringify(repo.rows[0]);
    for (const leaked of [
      'pharmacy-secret-1', 'branch-secret-1', 'listing-secret-1', 'res-secret-1', 'product-amoxicillin', 'pharmacy-excluded-secret',
      'pharmacyId', 'excludedPharmacyId', 'result', 'lines', 'orderId',
    ]) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  it('a match states a pharmacy was found — not accepted, ready, paid, dispatched or dispensed', () => {
    for (const language of ['en', 'am'] as const) {
      const r = renderNotification(NotificationTemplateCode.MATCHING_ORDER_MATCHED, language, {});
      expect(`${r.title} ${r.body}`).not.toMatch(/accept|ready|paid|payment|deliver|dispens|on its way|amoxicillin|\d/i);
    }
  });

  it('a rematch states the move only — no pharmacy, reason, cancellation or required action', () => {
    for (const language of ['en', 'am'] as const) {
      const r = renderNotification(NotificationTemplateCode.MATCHING_REMATCH_TRIGGERED, language, {});
      expect(`${r.title} ${r.body}`).not.toMatch(/because|reason|cancel|declin|out of stock|please|must|action|\d/i);
    }
  });

  it('renders in Amharic for an Amharic-speaking customer', async () => {
    languages[CUSTOMER] = PreferredLanguage.am;
    expect(await run(cases[0])).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ፋርማሲ ተገኝቷል', body: 'ጥያቄዎን ማሟላት የሚችል ፋርማሲ ተገኝቷል።' });
    await run(cases[1]);
    expect(repo.rows[1]).toMatchObject({ title: 'ወደ ሌላ ፋርማሲ ተዛውሯል', body: 'ጥያቄዎ ወደ ሌላ ፋርማሲ ተዛውሯል።' });
  });

  it.each([[null], [undefined], ['fr']])('falls back to English for language %p', async (language) => {
    languages[CUSTOMER] = language as PreferredLanguage | null;
    expect(await run(cases[1])).toEqual({ created: true, language: 'en' });
    expect(repo.rows[0].title).toBe('Moved to another pharmacy');
  });

  it.each(cases)('%s for an unknown match request writes nothing, invents no recipient, and warns', async (...c) => {
    delete matchOwners[MATCH];
    expect(await run(c)).toEqual({ created: false, reason: 'MATCH_REQUEST_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining(`match request ${MATCH} not found`)]);
  });

  it.each(cases)('%s redelivered is recorded once, keyed eventId:customerUserId', async (...c) => {
    const eventId = randomUUID();
    expect((await run(c, eventId)).created).toBe(true);
    expect((await run(c, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${CUSTOMER}`]);
  });

  it('a match and a rematch of the same request are two notifications', async () => {
    await run(cases[0]);
    await run(cases[1]);
    expect(repo.rows.map((r) => r.templateCode)).toEqual(['MATCHING_ORDER_MATCHED', 'MATCHING_REMATCH_TRIGGERED']);
  });
});
