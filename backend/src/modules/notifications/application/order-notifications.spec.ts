import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { IOrderRecipientReadPort } from '../../orders/application/ports/inbound/order-recipient-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { RecordOrderNotificationCommand } from './commands/record-order-notification.command';
import { OrderLifecycleNotifications } from './support/event-notifications';

/** Only the write path matters here; the inbox reads are Work 01's and tested there. */
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
 * Module 13 Work 02's application layer, with Module 06 and Module 01 behind fake ports. The
 * claims: the recipient is the order's customer as Module 06 answers it and nobody else, the text
 * is the right template in the customer's language, and the write is Work 01's idempotent one.
 */
describe('Order lifecycle notifications (application)', () => {
  const CUSTOMER_A = 'customer-a';
  const ORDER_A = 'order-a';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let owners: Record<string, string>;
  let logger: ReturnType<typeof fakeLogger>;
  let command: RecordOrderNotificationCommand;
  let lookups: string[];

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [CUSTOMER_A]: PreferredLanguage.en };
    owners = { [ORDER_A]: CUSTOMER_A };
    lookups = [];
    logger = fakeLogger();
    const languagePort: IIdentityLanguageReadPort = { preferredLanguageOf: async (id) => languages[id] ?? null };
    const orderPort: IOrderRecipientReadPort = {
      customerUserIdOf: async (orderId) => {
        lookups.push(orderId);
        return owners[orderId] ?? null;
      },
    };
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, languagePort);
    command = new RecordOrderNotificationCommand(orderPort, record, logger);
  });

  const accepted = { orderId: ORDER_A, fulfillmentId: 'ful-1', pharmacyId: 'pharm-1' };
  const ready = { orderId: ORDER_A, fulfillmentId: 'ful-1' };
  const cancelled = { orderId: ORDER_A, reason: 'Changed my mind, ordered elsewhere' };

  const run = <T extends { orderId: string }>(
    eventType: string,
    payload: T,
    toIntent: (p: T, customerUserId: string) => ReturnType<typeof OrderLifecycleNotifications.orderReady>,
    eventId = randomUUID(),
  ) => command.execute({ eventId, eventType, payload, toIntent });

  // -------------------------------------------------------------------------------------------
  // Each event
  // -------------------------------------------------------------------------------------------

  it.each([
    ['order.accepted', accepted, OrderLifecycleNotifications.orderAccepted, NotificationTemplateCode.ORDER_ACCEPTED, { orderId: ORDER_A }, 'Order accepted'],
    ['order.ready', ready, OrderLifecycleNotifications.orderReady, NotificationTemplateCode.ORDER_READY, { orderId: ORDER_A }, 'Order ready'],
    [
      'order.cancelled',
      cancelled,
      OrderLifecycleNotifications.orderCancelled,
      NotificationTemplateCode.ORDER_CANCELLED,
      { orderId: ORDER_A, reason: 'Changed my mind, ordered elsewhere' },
      'Order cancelled',
    ],
  ] as const)('%s → the order’s customer, the right template, approved fields only', async (eventType, payload, toIntent, templateCode, data, title) => {
    const eventId = randomUUID();
    const result = await run(eventType, payload as never, toIntent as never, eventId);

    expect(result).toEqual({ created: true, language: 'en' });
    expect(lookups).toEqual([ORDER_A]);
    expect(repo.rows).toEqual([
      {
        recipientUserId: CUSTOMER_A,
        category: NotificationCategory.TRANSACTIONAL,
        channel: NotificationChannel.IN_APP,
        templateCode,
        eventType,
        dedupeKey: `${eventId}:${CUSTOMER_A}`,
        data,
        title,
        body: expect.any(String),
        status: NotificationStatus.SENT,
      },
    ]);
    const raw = JSON.stringify(repo.rows[0].data);
    for (const leaked of ['ful-1', 'pharm-1', 'fulfillmentId', 'pharmacyId', 'customerUserId']) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  // -------------------------------------------------------------------------------------------
  // Language
  // -------------------------------------------------------------------------------------------

  it('renders in Amharic for an Amharic-speaking customer', async () => {
    languages[CUSTOMER_A] = PreferredLanguage.am;
    expect(await run('order.ready', ready, OrderLifecycleNotifications.orderReady)).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ትዕዛዝዎ ዝግጁ ነው', body: 'ትዕዛዝዎ ታሽጎ ለመላክ ዝግጁ ነው።' });
  });

  it.each([[null], [undefined], ['fr']])('falls back to English for language %p', async (language) => {
    languages[CUSTOMER_A] = language as PreferredLanguage | null;
    expect(await run('order.accepted', accepted, OrderLifecycleNotifications.orderAccepted)).toEqual({ created: true, language: 'en' });
    expect(repo.rows[0]).toMatchObject({
      title: 'Order accepted',
      body: 'The pharmacy has accepted your order and is preparing it.',
    });
  });

  it('renders every new template in both languages, Amharic in Ethiopic script', () => {
    for (const code of [NotificationTemplateCode.ORDER_ACCEPTED, NotificationTemplateCode.ORDER_READY, NotificationTemplateCode.ORDER_CANCELLED]) {
      const en = renderNotification(code, 'en', { orderId: 'o' });
      const am = renderNotification(code, 'am', { orderId: 'o' });
      expect(en.title.length * en.body.length * am.title.length * am.body.length).toBeGreaterThan(0);
      expect(am.title).toMatch(/[ሀ-፿]/);
      expect(en.title).not.toMatch(/[ሀ-፿]/);
    }
  });

  it('words a no-pharmacy-match cancellation specifically, and never echoes the customer’s own reason', () => {
    expect(renderNotification(NotificationTemplateCode.ORDER_CANCELLED, 'en', { reason: 'NO_PHARMACY_MATCH' }).body).toBe(
      'No pharmacy could fulfil your order, so it has been cancelled.',
    );
    expect(renderNotification(NotificationTemplateCode.ORDER_CANCELLED, 'am', { reason: 'NO_PHARMACY_MATCH' }).body).toBe(
      'ትዕዛዝዎን ማሟላት የሚችል ፋርማሲ ስላልተገኘ ትዕዛዝዎ ተሰርዟል።',
    );
    const own = renderNotification(NotificationTemplateCode.ORDER_CANCELLED, 'en', { reason: 'Changed my mind' });
    expect(own.body).toBe('Your order has been cancelled.');
    expect(own.body).not.toContain('Changed my mind');
  });

  // -------------------------------------------------------------------------------------------
  // Missing order, dedupe
  // -------------------------------------------------------------------------------------------

  it('writes nothing for an unknown order, invents no recipient, and logs a warning', async () => {
    const result = await run('order.cancelled', { orderId: 'order-gone', reason: 'x' }, OrderLifecycleNotifications.orderCancelled);
    expect(result).toEqual({ created: false, reason: 'ORDER_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining('order order-gone not found')]);
  });

  it('records a redelivered event once, keyed eventId:customerUserId', async () => {
    const eventId = randomUUID();
    expect((await run('order.ready', ready, OrderLifecycleNotifications.orderReady, eventId)).created).toBe(true);
    expect((await run('order.ready', ready, OrderLifecycleNotifications.orderReady, eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${CUSTOMER_A}`]);
  });

  it('lets distinct lifecycle events for one order each notify once', async () => {
    await run('order.accepted', accepted, OrderLifecycleNotifications.orderAccepted);
    await run('order.ready', ready, OrderLifecycleNotifications.orderReady);
    expect(repo.rows.map((r) => r.templateCode)).toEqual(['ORDER_ACCEPTED', 'ORDER_READY']);
  });

  it('passes a lookup failure through and writes nothing', async () => {
    const failing = new RecordOrderNotificationCommand(
      { customerUserIdOf: () => Promise.reject(new Error('db down')) },
      new RecordNotificationCommand(repo as unknown as INotificationRepository, { preferredLanguageOf: async () => null }),
      logger,
    );
    await expect(
      failing.execute({ eventId: 'e', eventType: 'order.ready', payload: ready, toIntent: OrderLifecycleNotifications.orderReady }),
    ).rejects.toThrow('db down');
    expect(repo.rows).toEqual([]);
  });

  it('keeps a missing cancellation reason as null rather than dropping or inventing it', () => {
    expect(OrderLifecycleNotifications.orderCancelled({ orderId: ORDER_A } as never, CUSTOMER_A).data).toEqual({ orderId: ORDER_A, reason: null });
  });
});
