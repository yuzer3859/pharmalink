import { IIdentityContactReadPort } from '../../identity/application/ports/inbound/identity-contact-read.port';
import { IConfigPort } from '../../../shared/config/config.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { DELIVERY_QUEUE_POLICY, EMAIL_DELIVERY_POLICY } from '../domain/delivery-retry-policy';
import { NotificationCategory, NotificationChannel } from '../domain/enums';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { EmailNotificationProvider } from '../infrastructure/providers/email-notification.provider';
import { classifyResendError, RESEND_SEND_URL, ResendEmailTransport, resendIdempotencyKey } from '../infrastructure/email/resend-email.transport';
import { RESEND_CONFIG_KEYS, ResendConfig } from '../infrastructure/email/resend.config';
import { ChannelDeliveryRequest } from './ports/outbound/notification-channel-provider.port';
import { EmailMessage } from './ports/outbound/email-transport.port';

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(String(m));
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & { lines: string[] };
}

const API_KEY = 're_TESTKEY_abcdefghijklmnop_SECRET';
const FROM = 'PharmaLink <alerts@notify.example.com>';
const TO = 'customer.a@example.com';
const SETTINGS = { [RESEND_CONFIG_KEYS.apiKey]: API_KEY, [RESEND_CONFIG_KEYS.fromEmail]: FROM };

type Call = { url: string; init: RequestInit };

/** Module 13 Work 17: the Resend transport — configuration, request shape, error mapping, privacy. */
describe('Resend e-mail transport (application)', () => {
  let calls: Call[];
  let reply: () => Response | Promise<Response>;
  let logger: ReturnType<typeof fakeLogger>;
  const fetchFake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  const config = (values: Record<string, string | undefined>) =>
    new ResendConfig({ get: (k: string) => values[k], getOrThrow: () => '', isFeatureEnabled: () => false } as unknown as IConfigPort);
  const transport = (values: Record<string, string | undefined> = SETTINGS, f: typeof fetch = fetchFake) => new ResendEmailTransport(config(values), logger, f);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const resendError = (status: number, name: string) => json(status, { statusCode: status, name, message: `The ${TO} address and key ${API_KEY} were refused.` });
  const message: EmailMessage = { to: TO, subject: 'Order ready', text: 'Your order is packed and ready to be sent out.', reference: 'n-1' };

  beforeEach(() => {
    calls = [];
    logger = fakeLogger();
    reply = () => json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
  });

  describe('configuration', () => {
    it.each([
      ['no API key', { [RESEND_CONFIG_KEYS.fromEmail]: FROM }],
      ['no sender', { [RESEND_CONFIG_KEYS.apiKey]: API_KEY }],
      ['a blank sender', { ...SETTINGS, [RESEND_CONFIG_KEYS.fromEmail]: '   ' }],
      ['a sender with no address', { ...SETTINGS, [RESEND_CONFIG_KEYS.fromEmail]: 'PharmaLink' }],
      ['NODE_ENV=test, even with both set', { ...SETTINGS, NODE_ENV: 'test' }],
    ])('%s → not configured, NOT_CONFIGURED, no request', async (_l, values) => {
      const t = transport(values);
      expect(t.isConfigured()).toBe(false);
      expect(await t.send(message, 1000)).toEqual({ kind: 'NOT_CONFIGURED' });
      expect(calls).toEqual([]);
    });

    it('reports missing keys by name only', () => {
      expect(config({}).missing()).toEqual(['RESEND_API_KEY', 'RESEND_FROM_EMAIL']);
      expect(config(SETTINGS).missing()).toEqual([]);
    });
  });

  describe('request', () => {
    it('POSTs exactly { from, to, subject, text } with Bearer auth and a stable idempotency key', async () => {
      const t = transport();
      expect(t.isConfigured()).toBe(true);
      expect(await t.send(message, 1000)).toEqual({ kind: 'SENT', messageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(RESEND_SEND_URL);
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers).toEqual({
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        'idempotency-key': 'notification-email/n-1',
      });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: FROM, to: [TO], subject: 'Order ready', text: 'Your order is packed and ready to be sent out.' });
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });

    it('the same notification always carries the same idempotency key; different ones differ', async () => {
      const t = transport();
      await t.send(message, 1000);
      await t.send({ ...message, subject: 'retry' }, 1000);
      await t.send({ ...message, reference: 'n-2' }, 1000);
      expect(calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key'])).toEqual([
        'notification-email/n-1',
        'notification-email/n-1',
        'notification-email/n-2',
      ]);
      expect(resendIdempotencyKey('x'.repeat(400))).toHaveLength(256);
    });

    it('sends the Amharic rendering byte-for-byte; adds no HTML, footer, greeting, link, headers, tags or ids', async () => {
      const am = renderNotification(NotificationTemplateCode.ORDER_READY, 'am', {});
      await transport().send({ to: TO, subject: am.title, text: am.body, reference: 'n-1' }, 1000);
      const sent = JSON.parse(String(calls[0].init.body));
      expect(sent).toEqual({ from: FROM, to: [TO], subject: am.title, text: am.body });
      expect(Object.keys(sent).sort()).toEqual(['from', 'subject', 'text', 'to']);
      expect(String(calls[0].init.body)).not.toMatch(/html|unsubscribe|http|n-1|tags|headers/i);
    });

    it('keeps only a truncated id from a success, nothing else from the response', async () => {
      reply = () => json(200, { id: 'x'.repeat(300), object: 'email', to: TO });
      expect(await transport().send(message, 1000)).toEqual({ kind: 'SENT', messageId: 'x'.repeat(128) });
    });
  });

  describe('error mapping', () => {
    it.each([
      [401, 'missing_api_key', { kind: 'NOT_CONFIGURED' }],
      [403, 'invalid_permission', { kind: 'NOT_CONFIGURED' }],
      [403, 'restricted_api_key', { kind: 'NOT_CONFIGURED' }],
      [403, 'suspended_api_key', { kind: 'NOT_CONFIGURED' }],
      [403, 'validation_error', { kind: 'NOT_CONFIGURED' }], // sender domain not verified / test-mode recipient
      [429, 'daily_quota_exceeded', { kind: 'NOT_CONFIGURED' }],
      [429, 'monthly_quota_exceeded', { kind: 'NOT_CONFIGURED' }],
      [404, 'not_found', { kind: 'NOT_CONFIGURED' }],
      [429, 'rate_limit_exceeded', { kind: 'TRANSIENT', code: 'EMAIL_RATE_LIMITED' }],
      [409, 'concurrent_idempotent_requests', { kind: 'TRANSIENT', code: 'EMAIL_CONCURRENT_REQUEST' }],
      [500, 'application_error', { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' }],
      [503, 'service_unavailable', { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' }],
      [422, 'validation_error', { kind: 'REJECTED', code: 'EMAIL_REJECTED' }], // e.g. invalid `to`
      [400, 'validation_error', { kind: 'REJECTED', code: 'EMAIL_REJECTED' }],
      [422, 'missing_required_field', { kind: 'REJECTED', code: 'EMAIL_REJECTED' }],
      [409, 'invalid_idempotent_request', { kind: 'REJECTED', code: 'EMAIL_REJECTED' }],
    ])('HTTP %i %s', async (status, name, expected) => {
      reply = () => resendError(status, name);
      expect(await transport().send(message, 1000)).toEqual(expected);
      expect(classifyResendError(status, name)).toEqual(expected);
    });

    it('an unparseable or id-less success is EMAIL_INVALID_RESULT (retryable — the idempotency key makes that safe)', async () => {
      reply = () => new Response('<html>ok</html>', { status: 200 });
      expect(await transport().send(message, 1000)).toEqual({ kind: 'TRANSIENT', code: 'EMAIL_INVALID_RESULT' });
      reply = () => json(200, { id: 42 });
      expect(await transport().send(message, 1000)).toEqual({ kind: 'TRANSIENT', code: 'EMAIL_INVALID_RESULT' });
      reply = () => new Response('garbage', { status: 502 });
      expect(await transport().send(message, 1000)).toEqual({ kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' });
    });

    it('a network error → EMAIL_NETWORK_ERROR; never rejects', async () => {
      const broken = (async () => {
        throw new TypeError(`fetch failed getaddrinfo api.resend.com ${API_KEY}`);
      }) as unknown as typeof fetch;
      await expect(transport(SETTINGS, broken).send(message, 1000)).resolves.toEqual({ kind: 'TRANSIENT', code: 'EMAIL_NETWORK_ERROR' });
    });

    it('a request outliving its timeout is aborted and reported EMAIL_TIMEOUT within the bound', async () => {
      const hanging = (async (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
      const started = Date.now();
      expect(await transport(SETTINGS, hanging).send(message, 50)).toEqual({ kind: 'TRANSIENT', code: 'EMAIL_TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('the provider passes the 15 s request timeout, capped at 30 s — both inside the 120 s lease', () => {
      expect(EMAIL_DELIVERY_POLICY).toEqual({ requestTimeoutMs: 15_000, deliveryDeadlineMs: 30_000 });
      expect(EMAIL_DELIVERY_POLICY.deliveryDeadlineMs * 2).toBeLessThanOrEqual(DELIVERY_QUEUE_POLICY.leaseMs);
    });
  });

  describe('through the e-mail provider', () => {
    const contacts: IIdentityContactReadPort = {
      smsRecipientOf: async () => {
        throw new Error('e-mail must not read the phone');
      },
      emailRecipientOf: async () => ({ available: true, email: TO }),
    };
    const request: ChannelDeliveryRequest = Object.freeze({
      notificationId: 'n-1',
      channel: NotificationChannel.EMAIL,
      category: NotificationCategory.TRANSACTIONAL,
      recipient: Object.freeze({ userId: 'user-a' }),
      title: 'Order ready',
      body: 'Your order is packed and ready to be sent out.',
    });
    const provider = (values: Record<string, string | undefined> = SETTINGS) => new EmailNotificationProvider(contacts, transport(values), logger);

    it.each([
      [200, null, { outcome: 'SENT', providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }],
      [422, 'validation_error', { outcome: 'FAILED', errorCode: 'EMAIL_REJECTED', retryable: false }],
      [429, 'rate_limit_exceeded', { outcome: 'FAILED', errorCode: 'EMAIL_RATE_LIMITED', retryable: true }],
      [503, 'service_unavailable', { outcome: 'FAILED', errorCode: 'EMAIL_UNAVAILABLE', retryable: true }],
      [401, 'missing_api_key', { outcome: 'NOT_CONFIGURED' }],
      [403, 'validation_error', { outcome: 'NOT_CONFIGURED' }],
    ])('HTTP %i %s → %j', async (status, name, expected) => {
      if (name) reply = () => resendError(status as number, name);
      expect(await provider().deliver(request)).toEqual(expected);
      expect(provider().name).toBe('resend');
    });

    it('missing configuration → NOT_CONFIGURED without reading the contact', async () => {
      const spy = jest.spyOn(contacts, 'emailRecipientOf');
      expect(await provider({ [RESEND_CONFIG_KEYS.apiKey]: API_KEY }).deliver(request)).toEqual({ outcome: 'NOT_CONFIGURED' });
      expect(spy).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  });

  it('never returns or logs the API key, the sender, the address, or Resend’s message text', async () => {
    const results: unknown[] = [];
    for (const [status, name] of [[401, 'missing_api_key'], [403, 'validation_error'], [422, 'validation_error'], [503, 'service_unavailable']] as const) {
      reply = () => resendError(status, name);
      results.push(await transport().send(message, 1000));
    }
    const broken = (async () => {
      throw new Error(`boom ${API_KEY} ${TO}`);
    }) as unknown as typeof fetch;
    results.push(await transport(SETTINGS, broken).send(message, 1000));
    const out = JSON.stringify(results) + logger.lines.join('\n');
    for (const secret of [API_KEY, 're_TESTKEY', TO, 'alerts@notify', 'were refused', 'boom']) {
      expect({ secret, found: out.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});
