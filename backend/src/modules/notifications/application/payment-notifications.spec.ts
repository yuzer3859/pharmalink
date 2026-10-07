import { randomUUID } from 'crypto';
import { IIdentityLanguageReadPort, PreferredLanguage } from '../../identity/application/ports/inbound/identity-language-read.port';
import { IOrderRecipientReadPort } from '../../orders/application/ports/inbound/order-recipient-read.port';
import {
  IPaymentRecipientReadPort,
  PaymentRecipientView,
} from '../../payment/application/ports/inbound/payment-recipient-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { RecordNotificationCommand } from './commands/record-notification.command';
import { RecordOrderNotificationCommand } from './commands/record-order-notification.command';
import { RecordPaymentNotificationCommand } from './commands/record-payment-notification.command';
import { PaymentNotifications } from './support/event-notifications';

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
 * Module 13 Work 03's application layer with Modules 01, 06 and 07 behind fake ports. Captured
 * and failed resolve their customer through the order (Work 02's path, reused); refunded through
 * the payment. Everything after the recipient is Work 01's write, unchanged.
 */
describe('Payment notifications (application)', () => {
  const CUSTOMER = 'customer-a';
  const ORDER = 'order-a';
  const PAYMENT = 'payment-a';
  let repo: RecordingRepository;
  let languages: Record<string, PreferredLanguage | null>;
  let orderOwners: Record<string, string>;
  let payments: Record<string, PaymentRecipientView>;
  let logger: ReturnType<typeof fakeLogger>;
  let forOrder: RecordOrderNotificationCommand;
  let forPayment: RecordPaymentNotificationCommand;

  beforeEach(() => {
    repo = new RecordingRepository();
    languages = { [CUSTOMER]: PreferredLanguage.en };
    orderOwners = { [ORDER]: CUSTOMER };
    payments = { [PAYMENT]: { customerUserId: CUSTOMER, orderId: ORDER, currency: 'ETB' } };
    logger = fakeLogger();
    const languagePort: IIdentityLanguageReadPort = { preferredLanguageOf: async (id) => languages[id] ?? null };
    const orderPort: IOrderRecipientReadPort = { customerUserIdOf: async (id) => orderOwners[id] ?? null };
    const paymentPort: IPaymentRecipientReadPort = { recipientOf: async (id) => payments[id] ?? null };
    const record = new RecordNotificationCommand(repo as unknown as INotificationRepository, languagePort, NO_STORED_PREFERENCES);
    forOrder = new RecordOrderNotificationCommand(orderPort, record, logger);
    forPayment = new RecordPaymentNotificationCommand(paymentPort, record, logger);
  });

  // A provider reason as Module 07 publishes it — already sanitized — and fields that must not travel.
  const captured = { paymentId: PAYMENT, orderId: ORDER, fee: 1_000 };
  const failed = { paymentId: PAYMENT, orderId: ORDER, reason: 'Insufficient balance' };
  const refunded = { paymentId: PAYMENT, amount: 125_050 };

  const capture = (eventId = randomUUID()) =>
    forOrder.execute({ eventId, eventType: 'payment.captured', payload: captured, toIntent: PaymentNotifications.paymentCaptured });
  const fail = (eventId = randomUUID()) =>
    forOrder.execute({ eventId, eventType: 'payment.failed', payload: failed, toIntent: PaymentNotifications.paymentFailed });
  const refund = (eventId = randomUUID(), payload: { paymentId: string; amount: number } = refunded) =>
    forPayment.execute({ eventId, eventType: 'payment.refunded', payload, toIntent: PaymentNotifications.paymentRefunded });

  // -------------------------------------------------------------------------------------------
  // Each event
  // -------------------------------------------------------------------------------------------

  it.each([
    ['payment.captured', capture, NotificationTemplateCode.PAYMENT_CAPTURED, { paymentId: PAYMENT, orderId: ORDER }, 'Payment completed'],
    [
      'payment.failed',
      fail,
      NotificationTemplateCode.PAYMENT_FAILED,
      { paymentId: PAYMENT, orderId: ORDER, reason: 'Insufficient balance' },
      'Payment failed',
    ],
    [
      'payment.refunded',
      refund,
      NotificationTemplateCode.PAYMENT_REFUNDED,
      { paymentId: PAYMENT, orderId: ORDER, amount: 125_050, currency: 'ETB' },
      'Refund completed',
    ],
  ] as const)('%s → the customer, the right template, approved fields only', async (eventType, run, templateCode, data, title) => {
    const eventId = randomUUID();
    expect(await run(eventId)).toEqual({ created: true, language: 'en' });
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
    expect(Object.keys(repo.rows[0].data)).not.toContain('fee');
  });

  it('renders the refund amount from minor units in the payment’s currency', async () => {
    await refund();
    expect(repo.rows[0].body).toBe('A refund of 1,250.50 ETB has been completed for your payment.');
  });

  it('keeps the failure reason out of the body — it travels in data only', async () => {
    await fail();
    expect(repo.rows[0].body).toBe('Your payment could not be completed.');
    expect(repo.rows[0].body).not.toContain('Insufficient');
  });

  // -------------------------------------------------------------------------------------------
  // Language
  // -------------------------------------------------------------------------------------------

  it('renders in Amharic for an Amharic-speaking customer', async () => {
    languages[CUSTOMER] = PreferredLanguage.am;
    expect(await refund()).toEqual({ created: true, language: 'am' });
    expect(repo.rows[0]).toMatchObject({ title: 'ገንዘብዎ ተመላሽ ሆኗል', body: 'ለክፍያዎ 1,250.50 ETB ተመላሽ ተደርጓል።' });
  });

  it.each([[null], [undefined], ['xx']])('falls back to English for language %p', async (language) => {
    languages[CUSTOMER] = language as PreferredLanguage | null;
    expect((await capture()).created).toBe(true);
    expect(repo.rows[0]).toMatchObject({ title: 'Payment completed', body: 'Your payment for your order has been completed.' });
  });

  it('renders every new template in both languages, Amharic in Ethiopic script', () => {
    const data = { amount: 100, currency: 'ETB' };
    for (const code of [NotificationTemplateCode.PAYMENT_CAPTURED, NotificationTemplateCode.PAYMENT_FAILED, NotificationTemplateCode.PAYMENT_REFUNDED]) {
      const en = renderNotification(code, 'en', data);
      const am = renderNotification(code, 'am', data);
      expect(en.title.length * en.body.length * am.title.length * am.body.length).toBeGreaterThan(0);
      expect(am.title).toMatch(/[ሀ-፿]/);
      expect(en.title).not.toMatch(/[ሀ-፿]/);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Missing subjects, dedupe, privacy
  // -------------------------------------------------------------------------------------------

  it('writes nothing when the order of a captured/failed payment is gone, and warns', async () => {
    delete orderOwners[ORDER];
    expect(await capture()).toEqual({ created: false, reason: 'ORDER_NOT_FOUND' });
    expect(await fail()).toEqual({ created: false, reason: 'ORDER_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toHaveLength(2);
  });

  it('writes nothing for a refund of an unknown payment, invents no recipient, and warns', async () => {
    expect(await refund(randomUUID(), { paymentId: 'payment-gone', amount: 10 })).toEqual({ created: false, reason: 'PAYMENT_NOT_FOUND' });
    expect(repo.rows).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining('payment payment-gone not found')]);
  });

  it.each([
    ['captured', capture],
    ['failed', fail],
    ['refunded', refund],
  ] as const)('records a redelivered payment.%s once', async (_name, run) => {
    const eventId = randomUUID();
    expect((await run(eventId)).created).toBe(true);
    expect((await run(eventId)).created).toBe(false);
    expect(repo.rows.map((r) => r.dedupeKey)).toEqual([`${eventId}:${CUSTOMER}`]);
  });

  it('stores nothing a payment row holds beyond the approved view, whatever else the port or event carry', async () => {
    payments[PAYMENT] = {
      customerUserId: CUSTOMER,
      orderId: ORDER,
      currency: 'ETB',
      providerToken: 'tok_live_secret',
      providerRef: 'TXN-RAW-1',
      method: 'TELEBIRR',
    } as unknown as PaymentRecipientView;
    await forPayment.execute({
      eventId: randomUUID(),
      eventType: 'payment.refunded',
      payload: { ...refunded, rawWebhook: { card: '4111111111111111' } } as never,
      toIntent: PaymentNotifications.paymentRefunded,
    });
    const raw = JSON.stringify(repo.rows[0]);
    expect(Object.keys(repo.rows[0].data).sort()).toEqual(['amount', 'currency', 'orderId', 'paymentId']);
    for (const leaked of ['tok_live_secret', 'TXN-RAW-1', 'TELEBIRR', '4111111111111111', 'rawWebhook', 'providerToken']) {
      expect({ leaked, found: raw.includes(leaked) }).toEqual({ leaked, found: false });
    }
  });

  it('passes a recipient-lookup failure through and writes nothing', async () => {
    const failing = new RecordPaymentNotificationCommand(
      { recipientOf: () => Promise.reject(new Error('db down')) },
      new RecordNotificationCommand(repo as unknown as INotificationRepository, { preferredLanguageOf: async () => null }, NO_STORED_PREFERENCES),
      logger,
    );
    await expect(
      failing.execute({ eventId: 'e', eventType: 'payment.refunded', payload: refunded, toIntent: PaymentNotifications.paymentRefunded }),
    ).rejects.toThrow('db down');
    expect(repo.rows).toEqual([]);
  });
});
