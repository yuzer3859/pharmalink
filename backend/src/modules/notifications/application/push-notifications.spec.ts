import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createVerify, generateKeyPairSync, randomUUID } from 'crypto';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { IConfigPort } from '../../../shared/config/config.port';
import { DELIVERY_QUEUE_POLICY, PUSH_DELIVERY_POLICY } from '../domain/delivery-retry-policy';
import { DeliveryJobStatus, DigestFrequency, NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  ActiveDeviceToken,
  DevicePlatform,
  DeviceTokenView,
  IDeviceTokenRepository,
} from '../domain/repositories/device-token.repository';
import {
  ClaimedDeliveryJob,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../domain/repositories/notification-delivery.repository';
import { INotificationPreferenceRepository, StoredChannelPreference } from '../domain/repositories/notification-preference.repository';
import { StaticNotificationChannelProviderRegistry } from '../infrastructure/providers/notification-channel-provider.registry';
import { NO_ACTIVE_DEVICE, PushNotificationProvider } from '../infrastructure/providers/push-notification.provider';
import { classify, FCM_SCOPE, FCM_TOKEN_URL, FcmHttpV1Transport } from '../infrastructure/push/fcm-http-v1.transport';
import { FCM_CONFIG_KEYS, FcmConfig } from '../infrastructure/push/fcm.config';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { NotificationDevicesController } from '../interface/controllers/notification-devices.controller';
import { RegisterDeviceTokenDto } from '../interface/dtos/notification-device.dto';
import { toNotificationDeviceResponse } from '../interface/dtos/notification-device.response';
import { ManageDeviceTokensCommand } from './commands/manage-device-tokens.command';
import { ChannelDeliveryRequest } from './ports/outbound/notification-channel-provider.port';
import { IPushTransport, PushMessage, PushSendResult } from './ports/outbound/push-transport.port';
import { NotificationDeliveryDispatcher } from './services/notification-delivery.dispatcher';

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(String(m));
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & { lines: string[] };
}

/** `device_tokens` in memory: unique token, `isActive`, ownership on every user-facing call. */
class InMemoryDeviceTokens implements IDeviceTokenRepository {
  rows: Array<{ id: string; userId: string; token: string; platform: string; isActive: boolean; lastSeenAt: Date | null; createdAt: Date }> = [];
  deactivated: string[][] = [];
  private view = (r: (typeof this.rows)[number]): DeviceTokenView => ({ id: r.id, platform: r.platform, tokenSuffix: r.token.slice(-6), lastSeenAt: r.lastSeenAt, createdAt: r.createdAt });
  async register(userId: string, token: string, platform: DevicePlatform, now: Date) {
    let r = this.rows.find((x) => x.token === token);
    if (r) Object.assign(r, { userId, platform, isActive: true, lastSeenAt: now });
    else this.rows.push((r = { id: randomUUID(), userId, token, platform, isActive: true, lastSeenAt: now, createdAt: now }));
    return this.view(r);
  }
  async listActiveForUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId && r.isActive).map(this.view);
  }
  async deactivateForUser(id: string, userId: string) {
    const r = this.rows.find((x) => x.id === id && x.userId === userId);
    if (r) r.isActive = false;
    return !!r;
  }
  async activeTokensForDelivery(userId: string, limit: number): Promise<ActiveDeviceToken[]> {
    return this.rows.filter((r) => r.userId === userId && r.isActive).slice(0, limit).map((r) => ({ id: r.id, token: r.token }));
  }
  async deactivateByIds(ids: readonly string[]) {
    this.deactivated.push([...ids]);
    for (const r of this.rows) if (ids.includes(r.id)) r.isActive = false;
  }
}

/** A transport scripted per device token. */
class ScriptedTransport implements IPushTransport {
  configured = true;
  calls: Array<{ token: string; message: PushMessage; timeoutMs: number }> = [];
  script = new Map<string, PushSendResult | 'THROW' | 'HANG'>();
  isConfigured() {
    return this.configured;
  }
  async send(token: string, message: PushMessage, timeoutMs: number): Promise<PushSendResult> {
    this.calls.push({ token, message, timeoutMs });
    const s = this.script.get(token) ?? { kind: 'SENT', messageId: `m-${token.slice(-4)}` };
    if (s === 'THROW') throw new Error('socket hang up sk_live_SECRET');
    if (s === 'HANG') return new Promise(() => undefined);
    return s;
  }
}

const TOKEN_A1 = 'fcm-token-user-a-device-1-AAAA1111';
const TOKEN_A2 = 'fcm-token-user-a-device-2-AAAA2222';
const TOKEN_B1 = 'fcm-token-user-b-device-1-BBBB1111';

/** Module 13 Work 14: device tokens, the FCM transport, the push provider and its place in the queue. */
describe('Push notifications (application)', () => {
  let tokens: InMemoryDeviceTokens;
  let transport: ScriptedTransport;
  let logger: ReturnType<typeof fakeLogger>;
  let provider: PushNotificationProvider;

  beforeEach(() => {
    tokens = new InMemoryDeviceTokens();
    transport = new ScriptedTransport();
    logger = fakeLogger();
    provider = new PushNotificationProvider(tokens, transport, logger);
  });

  const request = (userId = 'user-a'): ChannelDeliveryRequest =>
    Object.freeze({ notificationId: 'n-1', channel: NotificationChannel.PUSH, category: NotificationCategory.TRANSACTIONAL, recipient: Object.freeze({ userId }), title: 'Order placed', body: 'We have received your order.' });
  const registerAll = async () => {
    await tokens.register('user-a', TOKEN_A1, 'ANDROID', new Date());
    await tokens.register('user-a', TOKEN_A2, 'IOS', new Date());
    await tokens.register('user-b', TOKEN_B1, 'ANDROID', new Date());
  };

  describe('device tokens', () => {
    let devices: ManageDeviceTokensCommand;
    beforeEach(() => (devices = new ManageDeviceTokensCommand(tokens)));

    it('registers, and re-registering the same token refreshes it instead of adding a row; one user may have many', async () => {
      const first = await devices.register('user-a', TOKEN_A1, 'ANDROID');
      const again = await devices.register('user-a', TOKEN_A1, 'ANDROID');
      await devices.register('user-a', TOKEN_A2, 'IOS');
      expect(again.id).toBe(first.id);
      expect(tokens.rows).toHaveLength(2);
      expect((await devices.list('user-a')).map((d) => d.platform)).toEqual(['ANDROID', 'IOS']);
    });

    it('a token registered by another account moves to it — the install now belongs to whoever signed in', async () => {
      await devices.register('user-a', TOKEN_A1, 'ANDROID');
      await devices.register('user-b', TOKEN_A1, 'ANDROID');
      expect(await devices.list('user-a')).toEqual([]);
      expect(await devices.list('user-b')).toHaveLength(1);
    });

    it('lists only the caller’s active devices; revoke deactivates only the owner’s; another user’s or unknown is 404', async () => {
      await registerAll();
      const [a1] = await devices.list('user-a');
      const [b1] = await devices.list('user-b');
      await expect(devices.revoke('user-a', b1.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(devices.revoke('user-a', randomUUID())).rejects.toBeInstanceOf(ApiException);
      await devices.revoke('user-a', a1.id);
      expect((await devices.list('user-a')).map((d) => d.id)).not.toContain(a1.id);
      expect(await devices.list('user-b')).toHaveLength(1);
      expect(tokens.rows.find((r) => r.id === a1.id)).toMatchObject({ isActive: false });
    });

    it('the response masks the token: id, platform, last six characters, timestamps — never the raw token or owner', async () => {
      const view = await devices.register('user-a', TOKEN_A1, 'ANDROID');
      const res = toNotificationDeviceResponse(view);
      expect(Object.keys(res)).toEqual(['id', 'platform', 'maskedToken', 'lastSeenAt', 'createdAt']);
      expect(res.maskedToken).toBe('…AA1111');
      expect(JSON.stringify(res)).not.toContain(TOKEN_A1);
      expect(JSON.stringify(res)).not.toContain('user-a');
    });

    const dto = (plain: object) =>
      validateSync(plainToInstance(RegisterDeviceTokenDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true });

    it('accepts { token, platform }', () => {
      expect(dto({ token: TOKEN_A1, platform: 'ANDROID' })).toEqual([]);
      expect(dto({ token: 'a:b-c_d.e~' + 'x'.repeat(10), platform: 'WEB' })).toEqual([]);
    });

    it.each([
      ['userId', { token: TOKEN_A1, platform: 'IOS', userId: 'someone' }],
      ['actorUserId', { token: TOKEN_A1, platform: 'IOS', actorUserId: 'x' }],
      ['isActive', { token: TOKEN_A1, platform: 'IOS', isActive: false }],
      ['provider credentials', { token: TOKEN_A1, platform: 'IOS', serverKey: 'AAAA' }],
      ['an unknown platform', { token: TOKEN_A1, platform: 'BLACKBERRY' }],
      ['a missing token', { platform: 'IOS' }],
      ['a short token', { token: 'short', platform: 'IOS' }],
      ['a token with spaces', { token: 'has spaces in it 1234', platform: 'IOS' }],
      ['an over-long token', { token: 'x'.repeat(4097), platform: 'IOS' }],
      ['a non-string token', { token: 1234567890123456, platform: 'IOS' }],
    ])('rejects %s', (_l, plain) => {
      expect(dto(plain)).not.toEqual([]);
    });

    it('register and revoke take notification:manage:own; listing takes notification:read:own', () => {
      const p = (m: keyof NotificationDevicesController) => Reflect.getMetadata(PERMISSIONS_KEY, NotificationDevicesController.prototype[m]);
      expect([p('register'), p('list'), p('revoke')]).toEqual([['notification:manage:own'], ['notification:read:own'], ['notification:manage:own']]);
    });
  });

  describe('push provider', () => {
    it('unconfigured → NOT_CONFIGURED, without reading tokens or calling the transport', async () => {
      transport.configured = false;
      const spy = jest.spyOn(tokens, 'activeTokensForDelivery');
      expect(await provider.deliver(request())).toEqual({ outcome: 'NOT_CONFIGURED' });
      expect(spy).not.toHaveBeenCalled();
      expect(transport.calls).toEqual([]);
    });

    it('no active device → FAILED NO_ACTIVE_DEVICE, not retryable', async () => {
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: NO_ACTIVE_DEVICE, retryable: false });
    });

    it('fans one delivery out to every active device of the recipient — never another user’s — with only the rendered text and id', async () => {
      await registerAll();
      expect(await provider.deliver(request())).toEqual({ outcome: 'SENT', providerMessageId: 'm-1111' });
      expect(transport.calls.map((c) => c.token).sort()).toEqual([TOKEN_A1, TOKEN_A2]);
      expect(transport.calls.every((c) => c.token !== TOKEN_B1)).toBe(true);
      expect(transport.calls[0].message).toEqual({ title: 'Order placed', body: 'We have received your order.', notificationId: 'n-1' });
      expect(transport.calls.every((c) => c.timeoutMs === PUSH_DELIVERY_POLICY.requestTimeoutMs)).toBe(true);
    });

    it('asks for at most maxDevicesPerDelivery devices', async () => {
      const spy = jest.spyOn(tokens, 'activeTokensForDelivery');
      await provider.deliver(request());
      expect(spy).toHaveBeenCalledWith('user-a', PUSH_DELIVERY_POLICY.maxDevicesPerDelivery);
    });

    it('one invalid + one valid device → SENT, and only the invalid token is deactivated', async () => {
      await registerAll();
      transport.script.set(TOKEN_A1, { kind: 'INVALID_TOKEN', code: 'FCM_UNREGISTERED' });
      expect(await provider.deliver(request())).toMatchObject({ outcome: 'SENT' });
      expect(tokens.rows.map((r) => [r.token, r.isActive])).toEqual([
        [TOKEN_A1, false],
        [TOKEN_A2, true],
        [TOKEN_B1, true],
      ]);
    });

    it('every device dead → FAILED with the service’s code, not retryable; all deactivated; the next delivery finds no device', async () => {
      await registerAll();
      transport.script.set(TOKEN_A1, { kind: 'INVALID_TOKEN', code: 'FCM_UNREGISTERED' });
      transport.script.set(TOKEN_A2, { kind: 'INVALID_TOKEN', code: 'FCM_SENDER_ID_MISMATCH' });
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: 'FCM_UNREGISTERED', retryable: false });
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: NO_ACTIVE_DEVICE, retryable: false });
      expect(transport.calls).toHaveLength(2);
    });

    it('transient failure (with or without a dead token alongside) → FAILED, retryable', async () => {
      await registerAll();
      transport.script.set(TOKEN_A1, { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' });
      transport.script.set(TOKEN_A2, { kind: 'INVALID_TOKEN', code: 'FCM_UNREGISTERED' });
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: 'FCM_UNAVAILABLE', retryable: true });
    });

    it('a rejected request → FAILED, not retryable; credentials refused → NOT_CONFIGURED', async () => {
      await tokens.register('user-a', TOKEN_A1, 'ANDROID', new Date());
      transport.script.set(TOKEN_A1, { kind: 'REJECTED', code: 'FCM_INVALID_ARGUMENT' });
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: 'FCM_INVALID_ARGUMENT', retryable: false });
      transport.script.set(TOKEN_A1, { kind: 'NOT_CONFIGURED' });
      expect(await provider.deliver(request())).toEqual({ outcome: 'NOT_CONFIGURED' });
      expect(tokens.rows[0].isActive).toBe(true);
    });

    it('a transport that throws is a retryable network failure; nothing of the exception leaks', async () => {
      await tokens.register('user-a', TOKEN_A1, 'ANDROID', new Date());
      transport.script.set(TOKEN_A1, 'THROW');
      const r = await provider.deliver(request());
      expect(r).toEqual({ outcome: 'FAILED', errorCode: 'FCM_NETWORK_ERROR', retryable: true });
      expect(JSON.stringify(r) + logger.lines.join()).not.toMatch(/SECRET|hang up|fcm-token/);
    });

    it('a transport that never answers is cut off at the delivery deadline as FCM_TIMEOUT', async () => {
      jest.useFakeTimers();
      try {
        await tokens.register('user-a', TOKEN_A1, 'ANDROID', new Date());
        transport.script.set(TOKEN_A1, 'HANG');
        const pending = provider.deliver(request());
        await jest.advanceTimersByTimeAsync(PUSH_DELIVERY_POLICY.deliveryDeadlineMs);
        expect(await pending).toEqual({ outcome: 'FAILED', errorCode: 'FCM_TIMEOUT', retryable: true });
      } finally {
        jest.useRealTimers();
      }
    });

    it('the timeouts are lease-safe: two request timeouts fit in the delivery deadline, which is far inside the lease', () => {
      expect(PUSH_DELIVERY_POLICY.requestTimeoutMs * 2).toBeLessThanOrEqual(PUSH_DELIVERY_POLICY.deliveryDeadlineMs);
      expect(PUSH_DELIVERY_POLICY.deliveryDeadlineMs * 2).toBeLessThanOrEqual(DELIVERY_QUEUE_POLICY.leaseMs);
    });

    it('logs no raw token when deactivating', async () => {
      await registerAll();
      transport.script.set(TOKEN_A1, { kind: 'INVALID_TOKEN', code: 'FCM_UNREGISTERED' });
      tokens.deactivateByIds = async () => {
        throw new Error(`db down ${TOKEN_A1}`);
      };
      await provider.deliver(request());
      expect(logger.lines.join()).not.toContain('fcm-token');
    });
  });

  describe('FCM HTTP v1 transport', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const ACCESS = 'ya29.ACCESS-TOKEN-SECRET';
    type Call = { url: string; init: RequestInit };
    const config = (values: Record<string, string | undefined>) =>
      new FcmConfig({ get: (k: string) => values[k], getOrThrow: () => '', isFeatureEnabled: () => false } as unknown as IConfigPort);
    const full = {
      [FCM_CONFIG_KEYS.projectId]: 'pharmalink-test',
      [FCM_CONFIG_KEYS.clientEmail]: 'push@pharmalink-test.iam.gserviceaccount.com',
      [FCM_CONFIG_KEYS.privateKey]: PEM.replace(/\n/g, '\\n'),
    };
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fcmError = (status: number, errorCode: string) =>
      json(status, { error: { code: status, message: `Requested entity was not found. token=${TOKEN_A1}`, status: 'X', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } });

    let calls: Call[];
    let sendReply: () => Response | Promise<Response>;
    let tokenReply: () => Response | Promise<Response>;
    const fetchFake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url === FCM_TOKEN_URL ? tokenReply() : sendReply();
    }) as unknown as typeof fetch;
    const transportWith = (values: Record<string, string | undefined> = full, f: typeof fetch = fetchFake) => new FcmHttpV1Transport(config(values), logger, f);
    const msg: PushMessage = { title: 'Order placed', body: 'We have received your order.', notificationId: 'n-1' };

    beforeEach(() => {
      calls = [];
      tokenReply = () => json(200, { access_token: ACCESS, expires_in: 3600, token_type: 'Bearer' });
      sendReply = () => json(200, { name: 'projects/pharmalink-test/messages/0:1500415314455276%31bd1c96' });
    });

    it('is not configured until all three keys are set, and then sends nothing over the network', async () => {
      for (const missing of Object.values(FCM_CONFIG_KEYS)) {
        const t = transportWith({ ...full, [missing]: undefined });
        expect(t.isConfigured()).toBe(false);
        expect(await t.send(TOKEN_A1, msg, 1000)).toEqual({ kind: 'NOT_CONFIGURED' });
      }
      expect(calls).toEqual([]);
      expect(config({}).missing()).toEqual(['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']);
    });

    it('exchanges a correctly signed service-account JWT once, then sends the documented v1 message', async () => {
      const t = transportWith();
      expect(t.isConfigured()).toBe(true);
      expect(await t.send(TOKEN_A1, msg, 1000)).toEqual({ kind: 'SENT', messageId: '0:1500415314455276%31bd1c96' });
      await t.send(TOKEN_A2, msg, 1000);
      expect(calls.map((c) => c.url)).toEqual([
        FCM_TOKEN_URL,
        'https://fcm.googleapis.com/v1/projects/pharmalink-test/messages:send',
        'https://fcm.googleapis.com/v1/projects/pharmalink-test/messages:send',
      ]);

      const form = new URLSearchParams(String(calls[0].init.body));
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, c, s] = form.get('assertion')!.split('.');
      expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      expect(claims).toMatchObject({ iss: full.FCM_CLIENT_EMAIL, scope: FCM_SCOPE, aud: FCM_TOKEN_URL });
      expect(claims.exp - claims.iat).toBe(3600);
      expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);

      const send = calls[1].init;
      expect((send.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
      expect(JSON.parse(String(send.body))).toEqual({
        message: { token: TOKEN_A1, notification: { title: 'Order placed', body: 'We have received your order.' }, data: { notificationId: 'n-1' } },
      });
      expect(send.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
      [404, 'UNREGISTERED', { kind: 'INVALID_TOKEN', code: 'FCM_UNREGISTERED' }],
      [403, 'SENDER_ID_MISMATCH', { kind: 'INVALID_TOKEN', code: 'FCM_SENDER_ID_MISMATCH' }],
      [400, 'INVALID_ARGUMENT', { kind: 'REJECTED', code: 'FCM_INVALID_ARGUMENT' }],
      [429, 'QUOTA_EXCEEDED', { kind: 'TRANSIENT', code: 'FCM_QUOTA_EXCEEDED' }],
      [503, 'UNAVAILABLE', { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' }],
      [500, 'INTERNAL', { kind: 'TRANSIENT', code: 'FCM_INTERNAL' }],
      [401, 'THIRD_PARTY_AUTH_ERROR', { kind: 'TRANSIENT', code: 'FCM_THIRD_PARTY_AUTH_ERROR' }],
    ])('maps HTTP %i / %s', async (status, code, expected) => {
      sendReply = () => fcmError(status, code);
      expect(await transportWith().send(TOKEN_A1, msg, 1000)).toEqual(expected);
    });

    it.each([
      [401, { kind: 'NOT_CONFIGURED' }],
      [403, { kind: 'NOT_CONFIGURED' }],
      [404, { kind: 'NOT_CONFIGURED' }],
      [400, { kind: 'REJECTED', code: 'FCM_INVALID_ARGUMENT' }],
      [502, { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' }],
      [418, { kind: 'TRANSIENT', code: 'FCM_ERROR' }],
    ])('without an FCM detail, HTTP %i maps to %j — a token is never invalidated on a bare status', (status, expected) => {
      expect(classify(status, null)).toEqual(expected);
    });

    it('a 401 drops the cached access token so the next send exchanges a fresh one', async () => {
      const t = transportWith();
      sendReply = () => json(401, { error: { code: 401 } });
      expect(await t.send(TOKEN_A1, msg, 1000)).toEqual({ kind: 'NOT_CONFIGURED' });
      sendReply = () => json(200, { name: 'projects/p/messages/2' });
      await t.send(TOKEN_A1, msg, 1000);
      expect(calls.filter((c) => c.url === FCM_TOKEN_URL)).toHaveLength(2);
    });

    it('the token exchange refused → NOT_CONFIGURED; unavailable → transient; an unusable key → NOT_CONFIGURED with no request', async () => {
      tokenReply = () => json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      expect(await transportWith().send(TOKEN_A1, msg, 1000)).toEqual({ kind: 'NOT_CONFIGURED' });
      tokenReply = () => json(503, {});
      expect(await transportWith().send(TOKEN_A1, msg, 1000)).toEqual({ kind: 'TRANSIENT', code: 'FCM_AUTH_UNAVAILABLE' });
      calls = [];
      expect(await transportWith({ ...full, FCM_PRIVATE_KEY: 'not-a-key' }).send(TOKEN_A1, msg, 1000)).toEqual({ kind: 'NOT_CONFIGURED' });
      expect(calls).toEqual([]);
    });

    it('a request that outlives its timeout is aborted and reported FCM_TIMEOUT, within the bound', async () => {
      const hanging = (async (url: string, init: RequestInit) => {
        if (url === FCM_TOKEN_URL) return tokenReply();
        return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
      }) as unknown as typeof fetch;
      const started = Date.now();
      expect(await transportWith(full, hanging).send(TOKEN_A1, msg, 50)).toEqual({ kind: 'TRANSIENT', code: 'FCM_TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('a network error → FCM_NETWORK_ERROR; never rejects', async () => {
      const broken = (async () => {
        throw new TypeError('fetch failed ECONNREFUSED');
      }) as unknown as typeof fetch;
      await expect(transportWith(full, broken).send(TOKEN_A1, msg, 1000)).resolves.toEqual({ kind: 'TRANSIENT', code: 'FCM_NETWORK_ERROR' });
    });

    it('never returns or logs the key, access token, device token or a response body', async () => {
      sendReply = () => fcmError(404, 'UNREGISTERED');
      const t = transportWith();
      const results = [await t.send(TOKEN_A1, msg, 1000)];
      tokenReply = () => json(401, { error: 'unauthorized_client', error_description: `key ${PEM}` });
      results.push(await transportWith().send(TOKEN_A1, msg, 1000));
      const out = JSON.stringify(results) + logger.lines.join('\n');
      for (const secret of [ACCESS, TOKEN_A1, 'PRIVATE KEY', 'Requested entity', 'unauthorized_client', full.FCM_CLIENT_EMAIL]) {
        expect({ secret: secret.slice(0, 12), found: out.includes(secret) }).toEqual({ secret: secret.slice(0, 12), found: false });
      }
    });
  });

  describe('in the delivery queue', () => {
    type Job = ClaimedDeliveryJob & { status: DeliveryJobStatus; nextAttemptAt: Date; lastErrorCode: string | null; lease: Date | null };
    class Queue implements INotificationDeliveryRepository {
      jobs: Job[] = [];
      attempts: NewDeliveryAttempt[] = [];
      notification = { id: 'n-1', recipientUserId: 'user-a', category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.IN_APP, title: 'Order placed', body: 'We have received your order.' };
      async findDeliverable() {
        return { ...this.notification };
      }
      private due = (j: Job, now: Date) => (j.status === DeliveryJobStatus.PENDING && j.nextAttemptAt <= now) || (j.status === DeliveryJobStatus.PROCESSING && !!j.lease && j.lease <= now);
      async findDueJobIds(now: Date, channels: readonly NotificationChannel[], limit: number) {
        return this.jobs.filter((j) => channels.includes(j.channel) && this.due(j, now)).slice(0, limit).map((j) => j.id);
      }
      async claim(id: string, now: Date, lease: Date) {
        const j = this.jobs.find((x) => x.id === id)!;
        if (!this.due(j, now)) return null;
        Object.assign(j, { status: DeliveryJobStatus.PROCESSING, lease, leaseExpiresAt: lease });
        return { id: j.id, notificationId: j.notificationId, channel: j.channel, attemptCount: j.attemptCount, leaseExpiresAt: lease };
      }
      async settle(c: ClaimedDeliveryJob, s: DeliveryJobSettlement) {
        const j = this.jobs.find((x) => x.id === c.id)!;
        Object.assign(j, { status: s.status, attemptCount: s.attemptCount, lastErrorCode: s.lastErrorCode, lease: null });
        if (s.nextAttemptAt) j.nextAttemptAt = s.nextAttemptAt;
        if (s.attempt) this.attempts.push(s.attempt);
        return true;
      }
    }
    class Prefs implements INotificationPreferenceRepository {
      rows: StoredChannelPreference[] = [];
      async listForUser() {
        return this.rows;
      }
      async upsert() {}
    }
    let queue: Queue;
    let prefs: Prefs;
    let dispatcher: NotificationDeliveryDispatcher;
    const T0 = new Date('2026-10-07T12:00:00Z');

    beforeEach(async () => {
      queue = new Queue();
      prefs = new Prefs();
      queue.jobs.push({ id: 'job-push', notificationId: 'n-1', channel: NotificationChannel.PUSH, attemptCount: 0, leaseExpiresAt: T0, status: DeliveryJobStatus.PENDING, nextAttemptAt: new Date(0), lastErrorCode: null, lease: null });
      dispatcher = new NotificationDeliveryDispatcher(queue, prefs, new StaticNotificationChannelProviderRegistry([provider]), logger);
      await registerAll();
    });

    it('PUSH enabled (no stored preference) + devices + configured → COMPLETED with one SENT attempt by fcm', async () => {
      expect((await dispatcher.dispatchDue(T0)).outcomes).toEqual({ COMPLETED: 1 });
      expect(queue.attempts).toEqual([{ attemptNumber: 1, status: NotificationStatus.SENT, provider: 'fcm', providerMessageId: 'm-1111', errorCode: null }]);
      expect(transport.calls).toHaveLength(2);
    });

    it('PUSH disabled → SUPPRESSED, the transport never called', async () => {
      prefs.rows = [{ category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.PUSH, enabled: false, digestFrequency: DigestFrequency.IMMEDIATE }];
      expect((await dispatcher.dispatchDue(T0)).outcomes).toEqual({ SUPPRESSED: 1 });
      expect(transport.calls).toEqual([]);
    });

    it('credentials refused at send time → job back to PENDING, no attempt, no retry used', async () => {
      transport.script.set(TOKEN_A1, { kind: 'NOT_CONFIGURED' });
      transport.script.set(TOKEN_A2, { kind: 'NOT_CONFIGURED' });
      expect((await dispatcher.dispatchDue(T0)).outcomes).toEqual({ RELEASED: 1 });
      expect(queue.attempts).toEqual([]);
      expect(queue.jobs[0]).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    });

    it('a transient failure retries on the Work 13 schedule and exhausts on the fifth', async () => {
      transport.script.set(TOKEN_A1, { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' });
      transport.script.set(TOKEN_A2, { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' });
      let now = T0;
      for (let i = 0; i < 6; i++) {
        await dispatcher.dispatchDue(now);
        now = new Date(Math.max(+queue.jobs[0].nextAttemptAt, +now) + 1);
      }
      expect(queue.attempts.map((a) => [a.attemptNumber, a.errorCode])).toEqual([1, 2, 3, 4, 5].map((n) => [n, 'FCM_UNAVAILABLE']));
      expect(queue.jobs[0]).toMatchObject({ status: 'EXHAUSTED', attemptCount: 5 });
    });

    it('no device, or every device dead → EXHAUSTED after one attempt; no endless retries', async () => {
      tokens.rows = tokens.rows.filter((r) => r.userId !== 'user-a');
      expect((await dispatcher.dispatchDue(T0)).outcomes).toEqual({ EXHAUSTED: 1 });
      expect(queue.attempts).toEqual([{ attemptNumber: 1, status: NotificationStatus.FAILED, provider: 'fcm', providerMessageId: null, errorCode: 'NO_ACTIVE_DEVICE' }]);
      await dispatcher.dispatchDue(new Date(+T0 + 86_400_000));
      expect(queue.attempts).toHaveLength(1);
    });

    it('the registry binds PUSH only when FCM is configured; SMS and EMAIL never', () => {
      const bound = (configured: boolean) => {
        transport.configured = configured;
        const r = new StaticNotificationChannelProviderRegistry(transport.isConfigured() ? [provider] : []);
        return [NotificationChannel.PUSH, NotificationChannel.SMS, NotificationChannel.EMAIL].map((c) => r.providerFor(c)?.name ?? null);
      };
      expect(bound(false)).toEqual([null, null, null]);
      expect(bound(true)).toEqual(['fcm', null, null]);
    });
  });
});
