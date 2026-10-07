import { randomUUID } from 'crypto';
import { EmailContact, IIdentityContactReadPort } from '../../identity/application/ports/inbound/identity-contact-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { channelsToEnqueue } from '../domain/delivery-policy';
import { DELIVERY_QUEUE_POLICY, EMAIL_DELIVERY_POLICY } from '../domain/delivery-retry-policy';
import { emailContentOf } from '../domain/email-content';
import { DeliveryJobStatus, DigestFrequency, NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  ClaimedDeliveryJob,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../domain/repositories/notification-delivery.repository';
import { INotificationPreferenceRepository, StoredChannelPreference } from '../domain/repositories/notification-preference.repository';
import { NotificationTemplateCode, renderNotification } from '../domain/templates';
import { InMemoryEmailTransport } from '../infrastructure/email/in-memory-email.transport';
import { UnconfiguredEmailTransport } from '../infrastructure/email/unconfigured-email.transport';
import { EmailNotificationProvider } from '../infrastructure/providers/email-notification.provider';
import { StaticNotificationChannelProviderRegistry } from '../infrastructure/providers/notification-channel-provider.registry';
import { ChannelDeliveryRequest } from './ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryDispatcher } from './services/notification-delivery.dispatcher';

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(String(m));
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & { lines: string[] };
}

const EMAIL_A = 'customer.a@example.com';
const EMAIL_B = 'customer.b@example.com';

/** Module 13 Work 16: the e-mail provider, its content policy and its place in the delivery queue. */
describe('E-mail notifications (application)', () => {
  let contacts: Record<string, EmailContact>;
  let contactReads: string[];
  let transport: InMemoryEmailTransport;
  let logger: ReturnType<typeof fakeLogger>;
  let provider: EmailNotificationProvider;

  const contactPort: IIdentityContactReadPort = {
    smsRecipientOf: async () => {
      throw new Error('e-mail must not read the phone');
    },
    emailRecipientOf: async (userId) => {
      contactReads.push(userId);
      return contacts[userId] ?? { available: false, reason: 'UNKNOWN_USER' };
    },
  };

  beforeEach(() => {
    contacts = { 'user-a': { available: true, email: EMAIL_A }, 'user-b': { available: true, email: EMAIL_B } };
    contactReads = [];
    transport = new InMemoryEmailTransport();
    logger = fakeLogger();
    provider = new EmailNotificationProvider(contactPort, transport, logger);
  });

  const request = (over: Partial<ChannelDeliveryRequest> = {}): ChannelDeliveryRequest =>
    Object.freeze({
      notificationId: 'n-1',
      channel: NotificationChannel.EMAIL,
      category: NotificationCategory.TRANSACTIONAL,
      recipient: Object.freeze({ userId: 'user-a' }),
      title: 'Order ready',
      body: 'Your order is packed and ready to be sent out.',
      ...over,
    });

  describe('content', () => {
    it('subject = rendered title, text = rendered body, in English', () => {
      const en = renderNotification(NotificationTemplateCode.ORDER_READY, 'en', {});
      expect(emailContentOf(en)).toEqual({ subject: 'Order ready', text: 'Your order is packed and ready to be sent out.' });
    });

    it('and in Amharic — the same rendering, no separate translation', () => {
      const am = renderNotification(NotificationTemplateCode.ORDER_READY, 'am', {});
      expect(emailContentOf(am)).toEqual({ subject: am.title, text: am.body });
      expect(am.title + am.body).toMatch(/[ሀ-፿]/);
    });

    it('adds nothing: no id, link or detail; no medicine, dose or reason for prescription templates', () => {
      for (const code of [NotificationTemplateCode.PRESCRIPTION_APPROVED, NotificationTemplateCode.PRESCRIPTION_REJECTED, NotificationTemplateCode.MATCHING_FAILED]) {
        for (const lang of ['en', 'am'] as const) {
          const rendered = renderNotification(code, lang, { prescriptionId: 'rx-1', reason: 'Amoxicillin dose unclear' });
          const { subject, text } = emailContentOf(rendered);
          expect(text).toBe(rendered.body);
          expect(`${subject} ${text}`).not.toMatch(/rx-1|amoxicillin|dose|http|\d{4,}/i);
        }
      }
    });

    it('a subject never spans lines; empty parts fall back to the other', () => {
      expect(emailContentOf({ title: 'Two\nlines  here', body: 'b' }).subject).toBe('Two lines here');
      expect(emailContentOf({ title: '', body: 'Body' })).toEqual({ subject: 'Body', text: 'Body' });
    });
  });

  describe('provider', () => {
    it('sends subject and body to the recipient’s own verified address — and only the notification id as reference', async () => {
      expect(await provider.deliver(request())).toEqual({ outcome: 'SENT', providerMessageId: 'email-1' });
      expect(transport.sent).toEqual([
        { message: { to: EMAIL_A, subject: 'Order ready', text: 'Your order is packed and ready to be sent out.', reference: 'n-1' }, timeoutMs: EMAIL_DELIVERY_POLICY.requestTimeoutMs },
      ]);
      expect(Object.isFrozen(transport.sent[0].message)).toBe(true);
      expect(contactReads).toEqual(['user-a']);
      expect(provider.name).toBe('email-in-memory');
    });

    it('unconfigured → NOT_CONFIGURED without reading the contact or calling the provider; production’s transport is never configured', async () => {
      transport.configured = false;
      expect(await provider.deliver(request())).toEqual({ outcome: 'NOT_CONFIGURED' });
      expect(contactReads).toEqual([]);
      expect(transport.sent).toEqual([]);
      const prod = new UnconfiguredEmailTransport();
      expect(prod.isConfigured()).toBe(false);
      expect(await prod.send()).toEqual({ kind: 'NOT_CONFIGURED' });
    });

    it.each(['UNKNOWN_USER', 'INACTIVE', 'NO_EMAIL', 'UNVERIFIED'] as const)('a contact that is %s → FAILED, not retryable, nothing sent', async (reason) => {
      contacts['user-a'] = { available: false, reason };
      expect(await provider.deliver(request())).toEqual({ outcome: 'FAILED', errorCode: `EMAIL_RECIPIENT_${reason}`, retryable: false });
      expect(transport.sent).toEqual([]);
    });

    it.each([
      ['an invalid recipient', { kind: 'INVALID_RECIPIENT', code: 'EMAIL_MAILBOX_UNKNOWN' }, { outcome: 'FAILED', errorCode: 'EMAIL_MAILBOX_UNKNOWN', retryable: false }],
      ['a rejected message', { kind: 'REJECTED', code: 'EMAIL_CONTENT_REJECTED' }, { outcome: 'FAILED', errorCode: 'EMAIL_CONTENT_REJECTED', retryable: false }],
      ['a transient failure', { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' }, { outcome: 'FAILED', errorCode: 'EMAIL_UNAVAILABLE', retryable: true }],
      ['credentials refused', { kind: 'NOT_CONFIGURED' }, { outcome: 'NOT_CONFIGURED' }],
      ['an exception', 'THROW', { outcome: 'FAILED', errorCode: 'EMAIL_NETWORK_ERROR', retryable: true }],
      ['an invalid result', 'GARBAGE', { outcome: 'FAILED', errorCode: 'EMAIL_INVALID_RESULT', retryable: true }],
      ['a free-text code', { kind: 'INVALID_RECIPIENT', code: `550 no such user ${EMAIL_A}` }, { outcome: 'FAILED', errorCode: 'EMAIL_INVALID_RECIPIENT', retryable: false }],
    ])('%s', async (_l, behaviour, expected) => {
      transport.script.set(EMAIL_A, behaviour as never);
      expect(await provider.deliver(request())).toEqual(expected);
    });

    it('a provider that never answers is cut off at the deadline as a retryable EMAIL_TIMEOUT', async () => {
      jest.useFakeTimers();
      try {
        transport.script.set(EMAIL_A, 'HANG');
        const pending = provider.deliver(request());
        await jest.advanceTimersByTimeAsync(EMAIL_DELIVERY_POLICY.deliveryDeadlineMs);
        expect(await pending).toEqual({ outcome: 'FAILED', errorCode: 'EMAIL_TIMEOUT', retryable: true });
      } finally {
        jest.useRealTimers();
      }
    });

    it('the timeouts are lease-safe', () => {
      expect(EMAIL_DELIVERY_POLICY.requestTimeoutMs).toBeLessThan(EMAIL_DELIVERY_POLICY.deliveryDeadlineMs);
      expect(EMAIL_DELIVERY_POLICY.deliveryDeadlineMs * 2).toBeLessThanOrEqual(DELIVERY_QUEUE_POLICY.leaseMs);
    });

    it('never returns or logs the address, the provider’s exception text or a credential', async () => {
      const results: unknown[] = [];
      for (const b of ['THROW', 'GARBAGE', { kind: 'TRANSIENT', code: `421 try later ${EMAIL_A}` }] as const) {
        transport.script.set(EMAIL_A, b as never);
        results.push(await provider.deliver(request()));
      }
      const out = JSON.stringify(results) + logger.lines.join('\n');
      for (const secret of [EMAIL_A, 'customer.a', 'FAKE_EMAIL_SECRET', 'relay refused', '421']) expect({ secret, found: out.includes(secret) }).toEqual({ secret, found: false });
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
    const emailOff: StoredChannelPreference = { category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.EMAIL, enabled: false, digestFrequency: DigestFrequency.IMMEDIATE };
    let queue: Queue;
    let prefs: Prefs;
    const T0 = new Date('2026-10-07T12:00:00Z');
    const dispatcher = () => new NotificationDeliveryDispatcher(queue, prefs, new StaticNotificationChannelProviderRegistry([provider]), logger);
    const job = () => queue.jobs[0];

    beforeEach(() => {
      queue = new Queue();
      prefs = new Prefs();
      queue.jobs.push({ id: randomUUID(), notificationId: 'n-1', channel: NotificationChannel.EMAIL, status: DeliveryJobStatus.PENDING, attemptCount: 0, nextAttemptAt: new Date(0), lease: null, lastErrorCode: null });
    });

    it('an EMAIL job is queued when e-mail is enabled or unset, not when disabled; never for IN_APP', () => {
      expect(channelsToEnqueue(NotificationCategory.TRANSACTIONAL, [])).toContain(NotificationChannel.EMAIL);
      expect(channelsToEnqueue(NotificationCategory.TRANSACTIONAL, [emailOff])).not.toContain(NotificationChannel.EMAIL);
      expect(channelsToEnqueue(NotificationCategory.TRANSACTIONAL, [])).not.toContain(NotificationChannel.IN_APP);
    });

    it('configured → COMPLETED with one SENT attempt; no address on the attempt or the job; IN_APP untouched', async () => {
      expect((await dispatcher().dispatchDue(T0)).outcomes).toEqual({ COMPLETED: 1 });
      expect(queue.attempts).toEqual([{ attemptNumber: 1, status: 'SENT', provider: 'email-in-memory', providerMessageId: 'email-1', errorCode: null, channel: 'EMAIL' }]);
      expect(JSON.stringify(queue)).not.toContain(EMAIL_A);
      expect(queue.notification).toMatchObject({ channel: 'IN_APP', status: 'SENT' });
    });

    it('disabled after queuing → SUPPRESSED, no contact read, nothing sent', async () => {
      prefs.rows = [emailOff];
      expect((await dispatcher().dispatchDue(T0)).outcomes).toEqual({ SUPPRESSED: 1 });
      expect(contactReads).toEqual([]);
      expect(transport.sent).toEqual([]);
    });

    it('with production’s registry (no e-mail provider) the job is not read and stays PENDING', async () => {
      const prod = new NotificationDeliveryDispatcher(queue, prefs, new StaticNotificationChannelProviderRegistry([]), logger);
      expect(await prod.dispatchDue(T0)).toEqual({ due: 0, claimed: 0, outcomes: {} });
      expect(job()).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    });

    it('a transient failure retries on the Work 13 schedule and exhausts on the fifth', async () => {
      transport.script.set(EMAIL_A, { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' });
      let now = T0;
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        await dispatcher().dispatchDue(now);
        if (job().status === 'PENDING') delays.push(+job().nextAttemptAt - +now);
        now = new Date(Math.max(+job().nextAttemptAt, +now) + 1);
      }
      expect(delays).toEqual([30_000, 120_000, 600_000, 1_800_000]);
      expect(job()).toMatchObject({ status: 'EXHAUSTED', attemptCount: 5 });
      expect(transport.sent).toHaveLength(5);
    });

    it('a permanent invalid recipient ends the job after one attempt', async () => {
      transport.script.set(EMAIL_A, { kind: 'INVALID_RECIPIENT', code: 'EMAIL_MAILBOX_UNKNOWN' });
      await dispatcher().dispatchDue(T0);
      await dispatcher().dispatchDue(new Date(+T0 + 86_400_000));
      expect(job()).toMatchObject({ status: 'EXHAUSTED', attemptCount: 1, lastErrorCode: 'EMAIL_MAILBOX_UNKNOWN' });
      expect(transport.sent).toHaveLength(1);
    });

    it('credentials refused mid-flight → PENDING again, no attempt, no retry consumed', async () => {
      transport.script.set(EMAIL_A, { kind: 'NOT_CONFIGURED' });
      expect((await dispatcher().dispatchDue(T0)).outcomes).toEqual({ RELEASED: 1 });
      expect(queue.attempts).toEqual([]);
      expect(job()).toMatchObject({ status: 'PENDING', attemptCount: 0 });
    });
  });
});
