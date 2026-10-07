import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { IOrderRecipientReadPort } from '../../orders/application/ports/inbound/order-recipient-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { RecordOrderNotificationCommand } from './commands/record-order-notification.command';
import { DeliveryNotifications, NotificationIntent } from './support/event-notifications';

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
 * Module 13 Work 04's application layer, with Modules 01 and 06 behind fake ports. The four
 * delivery status events resolve their customer through the order (Work 02's path, reused);
 * Module 08 is not consulted at all.
 */
describe('Delivery notifications (application)', () => {
  const CUSTOMER = 'customer-a';
  const ORDER = 'order-a';
  const DRIVER_PROFILE = 'driver-profile-77';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let owners: Record<string, string>;
  let lookups: string[];
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordOrderNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [CUSTOMER]: PreferredLanguage.en };
    owners = { [ORDER]: CUSTOMER };
    lookups = [];
    logger = fakeLogger();
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, {
      preferredLanguageOf: async (id) => languages[id] ?? null,
    } satisfies IIdentityLanguageReadPort, NO_STORED_PREFERENCES);
    const orders: IOrderRecipientReadPort = {
      customerUserIdOf: async (id) => {
        lookups.push(id);
        return owners[id] ?? null;
      },
    };
    command = new RecordOrderNotificationCommand(orders, record, logger);
  });

  const status = (s: string) => ({ jobId: 'job-9', orderId: ORDER, fulfillmentId: 'ful-9', driverId: DRIVER_PROFILE, status: s });
  const failed = { ...status('FAILED'), reason: 'Customer not home, called +251911223344, neighbour said moved' };

  type Case = [string, object, (p: never, c: string) => NotificationIntent, NotificationTemplateCode, string, string];
  const cases: Case[] = [
    ['delivery.order.picked_up', status('PICKED_UP'), DeliveryNotifications.orderPickedUp, NotificationTemplateCode.DELIVERY_PICKED_UP, 'Order picked up', 'Your order has been picked up from the pharmacy.'],
    ['delivery.order.en_route', status('EN_ROUTE'), DeliveryNotifications.orderEnRoute, NotificationTemplateCode.DELIVERY_EN_ROUTE, 'Order on the way', 'Your order is on its way to you.'],
    ['delivery.order.delivered', status('DELIVERED'), DeliveryNotifications.orderDelivered, NotificationTemplateCode.DELIVERY_DELIVERED, 'Order delivered', 'Your order has been delivered.'],
    ['delivery.failed', failed, DeliveryNotifications.deliveryFailed, NotificationTemplateCode.DELIVERY_FAILED, 'Delivery failed', 'We could not deliver your order.'],
  ];

  const run = (c: Case, eventId = randomUUID()) =>
    command.execute({ eventId, eventType: c[0], payload: c[1] as { orderId: string }, toIntent: c[2] as never });

  // -------------------------------------------------------------------------------------------
  // Each event
  // -------------------------------------------------------------------------------------------

  it.each(cases)('%s → the order’s customer, the right template, { orderId } only', async (...c) => {
    const [eventType, , , templateCode, title, bodyText] = c;
    const eventId = randomUUID();
    expect(await run(c, eventId)).toEqual({ created: true, language: 'en' });
    expect(lookups).toEqual([ORDER]);
    expect(repo.rows).toEqual([
      {
        recipientUserId: CUSTOMER,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${CUSTOMER}`,
        data: { orderId: ORDER },
        title,
        body: bodyText,
        status: NotificationStatus.SENT,
      },
    ]);
  });

  it.each(cases)('%s leaks no driver, job, fulfillment, status or failure-reason data', async (...c) => {
    await run(c);
    // The row has its own `status` (SENT); the event's job status must not be in `data`.
    expect(Object.keys(repo.rows[0].data)).toEqual(['orderId']);
    const raw = JSON.stringify(repo.rows[0]);
    for (const leaked of [DRIVER_PROFILE, 'driverId', 'job-9', 'jobId', 'ful-9', 'fulfillmentId', 'reason', '+251911223344', 'neighbour']) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  // -------------------------------------------------------------------------------------------
  // Language
  // -------------------------------------------------------------------------------------------

  it('renders in Amharic for an Amharic-speaking customer', async () => {
    languages[CUSTOMER] = PreferredLanguage.am;
    expect(await run(cases[1])).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ትዕዛዝዎ በመንገድ ላይ ነው', body: 'ትዕዛዝዎ ወደ እርስዎ በመምጣት ላይ ነው።' });
  });

  it.each([[null], [undefined], ['de']])('falls back to English for language %p', async (language) => {
    languages[CUSTOMER] = language as PreferredLanguage | null;
    expect((await run(cases[2])).created).toBe(true);
    expect(repo.rows[0]).toMatchObject({ title: 'Order delivered', body: 'Your order has been delivered.' });
  });

  it('renders every delivery template in both languages, Amharic in Ethiopic script', () => {
    for (const [, , , code] of cases) {
      const en = renderNotification(code, 'en', { orderId: ORDER });
      const am = renderNotification(code, 'am', { orderId: ORDER });
      expect(en.title.length * en.body.length * am.title.length * am.body.length).toBeGreaterThan(0);
      expect(am.title).toMatch(/[ሀ-፿]/);
      expect(en.title).not.toMatch(/[ሀ-፿]/);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Missing order, dedupe
  // -------------------------------------------------------------------------------------------

  it.each(cases)('%s for an unknown order writes nothing, invents no recipient, and warns', async (...c) => {
    delete owners[ORDER];
    expect(await run(c)).toEqual({ created: false, reason: 'ORDER_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining(`order ${ORDER} not found`)]);
  });

  it.each(cases)('%s redelivered is recorded once, keyed eventId:customerUserId', async (...c) => {
    const eventId = randomUUID();
    expect((await run(c, eventId)).created).toBe(true);
    expect((await run(c, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${CUSTOMER}`]);
  });

  it('records each status of one delivery once, in the order it happened', async () => {
    for (const c of cases.slice(0, 3)) await run(c);
    expect(repo.rows.map((r) => r.templateCode)).toEqual(['DELIVERY_PICKED_UP', 'DELIVERY_EN_ROUTE', 'DELIVERY_DELIVERED']);
  });
});
