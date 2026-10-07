import { randomUUID } from 'crypto';
import { IIdentityContactReadPort, SmsContact } from '../../identity/application/ports/inbound/identity-contact-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { DELIVERY_QUEUE_POLICY, SMS_DELIVERY_POLICY } from '../domain/delivery-retry-policy';
import { channelsToEnqueue } from '../domain/delivery-policy';
import { DeliveryJobStatus, DigestFrequency, NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  ClaimedDeliveryJob,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../domain/repositories/notification-delivery.repository';
import { INotificationPreferenceRepository, StoredChannelPreference } from '../domain/repositories/notification-preference.repository';
import { smsTextOf } from '../domain/sms-content';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { StaticNotificationChannelProviderRegistry } from '../infrastructure/providers/notification-channel-provider.registry';
import { SmsNotificationProvider } from '../infrastructure/providers/sms-notification.provider';
import { InMemorySmsTransport } from '../infrastructure/sms/in-memory-sms.transport';
import { UnconfiguredSmsTransport } from '../infrastructure/sms/unconfigured-sms.transport';
import { ChannelDeliveryRequest } from './ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryDispatcher } from './services/notification-delivery.dispatcher';

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(String(m));
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & { lines: string[] };
}

const PHONE_A = '+251911000111';
const PHONE_B = '+251922000222';

/** Module 13 Work 15: the SMS provider, its content policy and its place in the delivery queue. */
describe('SMS notifications (application)', () => {
  let contacts: Record<string, SmsContact>;
  let contactReads: string[];
  let transport: InMemorySmsTransport;
  let logger: ReturnType<typeof fakeLogger>;
  let provider: SmsNotificationProvider;

  const contactPort: IIdentityContactReadPort = {
    smsRecipientOf: async (userId) => {
      contactReads.push(userId);
      return contacts[userId] ?? { available: false, reason: 'UNKNOWN_USER' };
    },
    // Work 16 extended the port; the SMS provider never calls this.
    emailRecipientOf: async () => {
      throw new Error('SMS must not read the e-mail address');
    },
    canonicalEmail: () => {
      throw new Error('SMS must not touch e-mail addresses');
    },
  };

  beforeEach(() => {
    contacts = { 'user-a': { available: true, phone: PHONE_A }, 'user-b': { available: true, phone: PHONE_B } };
    contactReads = [];
    transport = new InMemorySmsTransport();
    logger = fakeLogger();
    provider = new SmsNotificationProvider(contactPort, transport, logger);
  });

  const request = (over: Partial<ChannelDeliveryRequest> = {}): ChannelDeliveryRequest =>
    Object.freeze({
      notificationId: 'n-1',
      channel: NotificationChannel.SMS,
      category: NotificationCategory.TRANSACTIONAL,
      recipient: Object.freeze({ userId: 'user-a' }),
      title: 'Order ready',
      body: 'Your order is packed and ready to be sent out.',
      ...over,
    });

  describe('content', () => {
    it('is the rendered body, in the recipient’s language — English or Amharic', () => {
      const en = renderNotification(NotificationTemplateCode.ORDER_READY, 'en', {});
      const am = renderNotification(NotificationTemplateCode.ORDER_READY, 'am', {});
      expect(smsTextOf(en)).toBe('Your order is packed and ready to be sent out.');
      expect(smsTextOf(am)).toBe(am.body);
      expect(smsTextOf(am)).toMatch(/[ሀ-፿]/);
    });

    it('adds no id, link or detail; carries no medicine or reason for prescription templates', () => {
      for (const code of [NotificationTemplateCode.PRESCRIPTION_APPROVED, NotificationTemplateCode.PRESCRIPTION_REJECTED, NotificationTemplateCode.MATCHING_FAILED]) {
        for (const lang of ['en', 'am'] as const) {
          const text = smsTextOf(renderNotification(code, lang, { prescriptionId: 'rx-1', reason: 'Amoxicillin dose unclear' }));
          expect(text).not.toMatch(/rx-1|amoxicillin|dose|http|\d{4,}/i);
        }
      }
      expect(smsTextOf({ title: 'T', body: '' })).toBe('T');
    });
  });

  describe('provider', () => {
    it('sends the body to the recipient’s own verified phone and nowhere else', async () => {
      expect(await provider.deliver(request())).toEqual({ outcome: 'SENT', providerMessageId: 'sms-1' });
      expect(transport.sent).toEqual([{ to: PHONE_A, text: 'Your order is packed and ready to be sent out.', timeoutMs: SMS_DELIVERY_POLICY.requestTimeoutMs }]);
      expect(contactReads).toEqual(['user-a']);
      expect(provider.name).toBe('sms-in-memory');
    });

    it('unconfigured → NOT_CONFIGURED without reading the contact or calling the gateway', async () => {
      transport.configured = false;
      expect(await provider.deliver(request())).toEqual({ outcome: 'NOT_CONFIGURED' });
      expect(contactReads).toEqual([]);
      expect(transport.sent).toEqual([]);
    });

    it('production’s transport is never configured and sends nothing', async () => {
      const prod = new UnconfiguredSmsTransport();
      expect(prod.isConfigured()).toBe(false);
      expect(await prod.send()).toEqual({ kind: 'NOT_CONFIGURED' });
      expect(await new SmsNotificationProvider(contactPort, prod, logger).deliver(request())).toEqual({ outcome: 'NOT_CONFIGURED' });
    });

    it.each(['UNKNOWN_USER', 'INACTIVE', 'NO_PHONE', 'UNVERIFIED'] as const)('a contact that is %s → FAILED, not retryable, no SMS', async (reason) => {
      contacts['user-a'] = { available: false, reason };
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: `SMS_RECIPIENT_${reason}`, retryable: false });
      expect(transport.sent).toEqual([]);
    });

    it.each([
      ['an invalid recipient', { kind: 'INVALID_RECIPIENT', code: 'SMS_INVALID_NUMBER' }, { outcome: 'FAILED', errorCode: 'SMS_INVALID_NUMBER', retryable: false }],
      ['a rejected request', { kind: 'REJECTED', code: 'SMS_CONTENT_REJECTED' }, { outcome: 'FAILED', errorCode: 'SMS_CONTENT_REJECTED', retryable: false }],
      ['a transient failure', { kind: 'TRANSIENT', code: 'SMS_UNAVAILABLE' }, { outcome: 'FAILED', errorCode: 'SMS_UNAVAILABLE', retryable: true }],
      ['rate limiting', { kind: 'TRANSIENT', code: 'SMS_RATE_LIMITED' }, { outcome: 'FAILED', errorCode: 'SMS_RATE_LIMITED', retryable: true }],
      ['credentials refused', { kind: 'NOT_CONFIGURED' }, { outcome: 'NOT_CONFIGURED' }],
      ['an exception', 'THROW', { outcome: 'FAILED', errorCode: 'SMS_NETWORK_ERROR', retryable: true }],
      ['an invalid result', 'GARBAGE', { outcome: 'FAILED', errorCode: 'SMS_INVALID_RESULT', retryable: true }],
      ['a free-text code', { kind: 'TRANSIENT', code: `gateway down for ${PHONE_A}` }, { outcome: 'FAILED', errorCode: 'SMS_UNAVAILABLE', retryable: true }],
    ])('%s', async (_l, behaviour, expected) => {
      transport.script.set(PHONE_A, behaviour as never);
      expect(await provider.deliver(request())).toEqual(expected);
    });

    it('a gateway that never answers is cut off at the deadline as a retryable SMS_TIMEOUT', async () => {
      jest.useFakeTimers();
      try {
        transport.script.set(PHONE_A, 'HANG');
        const pending = provider.deliver(request());
        await jest.advanceTimersByTimeAsync(SMS_DELIVERY_POLICY.deliveryDeadlineMs);
        expect(await pending).toEqual({ outcome: 'FAILED', errorCode: 'SMS_TIMEOUT', retryable: true });
      } finally {
        jest.useRealTimers();
      }
    });

    it('the timeouts are lease-safe', () => {
      expect(SMS_DELIVERY_POLICY.requestTimeoutMs).toBeLessThan(SMS_DELIVERY_POLICY.deliveryDeadlineMs);
      expect(SMS_DELIVERY_POLICY.deliveryDeadlineMs * 2).toBeLessThanOrEqual(DELIVERY_QUEUE_POLICY.leaseMs);
    });

    it('never returns or logs the phone, the gateway’s exception text or a credential', async () => {
      const results: unknown[] = [];
      transport.script.set(PHONE_A, 'THROW');
      results.push(await provider.deliver(request()));
      transport.script.set(PHONE_A, 'GARBAGE');
      results.push(await provider.deliver(request()));
      transport.script.set(PHONE_A, { kind: 'INVALID_RECIPIENT', code: `bad number ${PHONE_A}` });
      results.push(await provider.deliver(request()));
      const out = JSON.stringify(results) + logger.lines.join('\n');
      for (const secret of [PHONE_A, '911000111', 'FAKE_SMS_SECRET', 'exploded']) expect({ secret, found: out.includes(secret) }).toEqual({ secret, found: false });
    });
  });

  describe('in the delivery queue', () => {
    type Job = { id: string; notificationId: string; channel: NotificationChannel; status: DeliveryJobStatus; attemptCount: number; nextAttemptAt: Date; lease: Date | null; lastErrorCode: string | null };
    class Queue implements INotificationDeliveryRepository {
      jobs: Job[] = [];
      attempts: Array<NewDeliveryAttempt & { channel: NotificationChannel }> = [];
      notification = { id: 'n-1', recipientUserId: 'user-a', category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.IN_APP, title: 'Order ready', body: 'Your order is packed and ready to be sent out.', status: NotificationStatus.SENT };
      async findDeliverable() {
        return { ...this.notification };
      }
      private due = (j: Job, now: Date) => (j.status === DeliveryJobStatus.PENDING && j.nextAttemptAt <= now) || (j.status === DeliveryJobStatus.PROCESSING && !!j.lease && j.lease <= now);
      async findDueJobIds(now: Date, channels: readonly NotificationChannel[], limit: number) {
        return this.jobs.filter((j) => channels.includes(j.channel) && this.due(j, now)).slice(0, limit).map((j) => j.id);
      }
      async claim(id: string, now: Date, lease: Date): Promise<ClaimedDeliveryJob | null> {
        const j = this.jobs.find((x) => x.id === id)!;
        if (!this.due(j, now)) return null;
        Object.assign(j, { status: DeliveryJobStatus.PROCESSING, lease });
        return { id: j.id, notificationId: j.notificationId, channel: j.channel, attemptCount: j.attemptCount, leaseExpiresAt: lease };
      }
      async settle(c: ClaimedDeliveryJob, s: DeliveryJobSettlement) {
        const j = this.jobs.find((x) => x.id === c.id)!;
        Object.assign(j, { status: s.status, attemptCount: s.attemptCount, lastErrorCode: s.lastErrorCode, lease: null });
        if (s.nextAttemptAt) j.nextAttemptAt = s.nextAttemptAt;
        if (s.attempt) this.attempts.push({ ...s.attempt, channel: c.channel });
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
    const smsOff: StoredChannelPreference = { category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.SMS, enabled: false, digestFrequency: DigestFrequency.IMMEDIATE };
    let queue: Queue;
    let prefs: Prefs;
    const T0 = new Date('2026-10-07T12:00:00Z');
    const dispatcher = (sms = provider) => new NotificationDeliveryDispatcher(queue, prefs, new StaticNotificationChannelProviderRegistry([sms]), logger);
    const job = () => queue.jobs[0];

    beforeEach(() => {
      queue = new Queue();
      prefs = new Prefs();
      queue.jobs.push({ id: randomUUID(), notificationId: 'n-1', channel: NotificationChannel.SMS, status: DeliveryJobStatus.PENDING, attemptCount: 0, nextAttemptAt: new Date(0), lease: null, lastErrorCode: null });
    });

    it('an SMS job is queued when SMS is enabled (or unset), not when it is disabled; never for IN_APP', () => {
      expect(channelsToEnqueue(NotificationCategory.TRANSACTIONAL, [])).toContain(NotificationChannel.SMS);
      expect(channelsToEnqueue(NotificationCategory.TRANSACTIONAL, [smsOff])).not.toContain(NotificationChannel.SMS);
      expect(channelsToEnqueue(NotificationCategory.TRANSACTIONAL, [])).not.toContain(NotificationChannel.IN_APP);
    });

    it('configured → COMPLETED with one SENT attempt; no phone on the attempt or the job', async () => {
      expect((await dispatcher().dispatchDue(T0)).outcomes).toEqual({ COMPLETED: 1 });
      expect(queue.attempts).toEqual([{ attemptNumber: 1, status: 'SENT', provider: 'sms-in-memory', providerMessageId: 'sms-1', errorCode: null, channel: 'SMS' }]);
      expect(JSON.stringify(queue)).not.toContain(PHONE_A);
    });

    it('disabled after queuing → SUPPRESSED, no contact read, no SMS', async () => {
      prefs.rows = [smsOff];
      expect((await dispatcher().dispatchDue(T0)).outcomes).toEqual({ SUPPRESSED: 1 });
      expect(contactReads).toEqual([]);
      expect(transport.sent).toEqual([]);
    });

    it('with production’s registry (no SMS provider) the job is not even read and stays PENDING', async () => {
      const prodRegistry = new NotificationDeliveryDispatcher(queue, prefs, new StaticNotificationChannelProviderRegistry([]), logger);
      expect(await prodRegistry.dispatchDue(T0)).toEqual({ due: 0, claimed: 0, outcomes: {} });
      expect(job()).toMatchObject({ status: 'PENDING', attemptCount: 0 });
      expect(queue.attempts).toEqual([]);
    });

    it('a transient failure retries on the Work 13 schedule and exhausts on the fifth', async () => {
      transport.script.set(PHONE_A, { kind: 'TRANSIENT', code: 'SMS_UNAVAILABLE' });
      let now = T0;
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        await dispatcher().dispatchDue(now);
        if (job().status === 'PENDING') delays.push(+job().nextAttemptAt - +now);
        now = new Date(Math.max(+job().nextAttemptAt, +now) + 1);
      }
      expect(delays).toEqual([30_000, 120_000, 600_000, 1_800_000]);
      expect(job()).toMatchObject({ status: 'EXHAUSTED', attemptCount: 5, lastErrorCode: 'SMS_UNAVAILABLE' });
      expect(transport.sent).toHaveLength(5);
    });

    it('an invalid recipient ends the job after one attempt — no five retries', async () => {
      transport.script.set(PHONE_A, { kind: 'INVALID_RECIPIENT', code: 'SMS_INVALID_NUMBER' });
      await dispatcher().dispatchDue(T0);
      await dispatcher().dispatchDue(new Date(+T0 + 86_400_000));
      expect(job()).toMatchObject({ status: 'EXHAUSTED', attemptCount: 1, lastErrorCode: 'SMS_INVALID_NUMBER' });
      expect(transport.sent).toHaveLength(1);
    });

    it('credentials refused mid-flight → back to PENDING, no attempt, no retry consumed', async () => {
      transport.script.set(PHONE_A, { kind: 'NOT_CONFIGURED' });
      expect((await dispatcher().dispatchDue(T0)).outcomes).toEqual({ RELEASED: 1 });
      expect(queue.attempts).toEqual([]);
      expect(job()).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    });

    it('leaves the in-app notification untouched', async () => {
      await dispatcher().dispatchDue(T0);
      expect(queue.notification).toMatchObject({ channel: 'IN_APP', status: 'SENT' });
    });
  });
});
