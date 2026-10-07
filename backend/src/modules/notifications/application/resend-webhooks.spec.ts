import { randomUUID } from 'crypto';
import { IIdentityContactReadPort } from '../../identity/application/ports/inbound/identity-contact-read.port';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { DeliveryJobStatus, NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  ClaimedDeliveryJob,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../domain/repositories/notification-delivery.repository';
import {
  EmailAttemptRef,
  IDestinationSuppressionRepository,
  IEmailWebhookRepository,
  WebhookEffect,
} from '../domain/repositories/email-webhook.repository';
import { INotificationPreferenceRepository } from '../domain/repositories/notification-preference.repository';
import { suppressionKeyOf } from '../domain/suppression';
import { InMemoryEmailTransport } from '../infrastructure/email/in-memory-email.transport';
import { EmailNotificationProvider } from '../infrastructure/providers/email-notification.provider';
import { StaticNotificationChannelProviderRegistry } from '../infrastructure/providers/notification-channel-provider.registry';
import { parseResendEmailEvent, eventTypeOf } from '../infrastructure/webhooks/resend-webhook.parser';
import { signSvix, verifySvixSignature, SVIX_TIMESTAMP_TOLERANCE_SECONDS } from '../infrastructure/webhooks/svix-signature';
import { EmailDeliveryReport, ProcessEmailDeliveryReportCommand } from './commands/process-email-delivery-report.command';
import { DestinationSuppressionService } from './services/destination-suppression.service';
import { NotificationDeliveryDispatcher } from './services/notification-delivery.dispatcher';

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(String(m));
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & { lines: string[] };
}

const SECRET = `whsec_${Buffer.from('a-32-byte-test-signing-secret!!!').toString('base64')}`;
const ADDRESS = 'Customer.A@Example.com';
const CANONICAL = 'customer.a@example.com';

/**
 * `notification_webhook_receipts` + `delivery_attempts` + `suppression_list` in memory, with the
 * database's guarantees: a unique receipt key checked and set atomically, all-or-nothing effects.
 */
class Store implements IEmailWebhookRepository, IDestinationSuppressionRepository {
  receipts = new Map<string, string>();
  attempts: Array<{ notificationId: string; attemptNumber: number; channel: NotificationChannel; provider: string | null; providerMsgId: string | null; status: NotificationStatus; errorCode: string | null }> = [];
  suppressed = new Map<string, string>();
  failNextEffect = false;

  async findEmailAttempt(id: string): Promise<EmailAttemptRef | null> {
    const a = this.attempts.find((x) => x.channel === NotificationChannel.EMAIL && x.status === NotificationStatus.SENT && x.providerMsgId === id);
    return a ? { notificationId: a.notificationId, attemptNumber: a.attemptNumber, provider: a.provider, providerMessageId: id } : null;
  }

  async applyOnce(receipt: { provider: string; eventId: string; eventType: string }, effect: WebhookEffect): Promise<boolean> {
    const key = `${receipt.provider}|${receipt.eventId}`;
    if (this.receipts.has(key)) return false;
    this.receipts.set(key, receipt.eventType);
    await Promise.resolve(); // let a concurrent copy run into the key
    if (this.failNextEffect) {
      this.failNextEffect = false;
      this.receipts.delete(key); // rollback
      throw new Error('database unavailable');
    }
    const r = effect.receiptAttempt;
    if (r && !this.attempts.some((a) => a.notificationId === r.ref.notificationId && a.providerMsgId === r.ref.providerMessageId && a.status === r.status && a.errorCode === r.errorCode)) {
      this.attempts.push({ notificationId: r.ref.notificationId, attemptNumber: r.ref.attemptNumber, channel: NotificationChannel.EMAIL, provider: r.ref.provider, providerMsgId: r.ref.providerMessageId, status: r.status, errorCode: r.errorCode });
    }
    for (const k of effect.suppress?.keys ?? []) if (!this.suppressed.has(`${effect.suppress!.channel}|${k}`)) this.suppressed.set(`${effect.suppress!.channel}|${k}`, effect.suppress!.reason);
    return true;
  }

  async isSuppressed(channel: NotificationChannel, key: string) {
    return this.suppressed.has(`${channel}|${key}`);
  }
}

describe('Resend webhooks and suppression (application)', () => {
  let store: Store;
  let logger: ReturnType<typeof fakeLogger>;
  let command: ProcessEmailDeliveryReportCommand;
  const contacts: IIdentityContactReadPort = {
    smsRecipientOf: async () => {
      throw new Error('unused');
    },
    emailRecipientOf: async () => ({ available: true, email: CANONICAL }),
    canonicalEmail: (raw) => (raw.includes('@') ? raw.trim().toLowerCase() : null),
  };

  beforeEach(() => {
    store = new Store();
    logger = fakeLogger();
    command = new ProcessEmailDeliveryReportCommand(store, contacts, logger);
    store.attempts.push({ notificationId: 'n-1', attemptNumber: 1, channel: NotificationChannel.EMAIL, provider: 'resend', providerMsgId: 're-1', status: NotificationStatus.SENT, errorCode: null });
  });

  const report = (over: Partial<EmailDeliveryReport> = {}): EmailDeliveryReport => ({
    provider: 'resend',
    eventId: `msg_${randomUUID()}`,
    eventType: 'email.delivered',
    kind: 'DELIVERED',
    providerMessageId: 're-1',
    recipients: [ADDRESS],
    permanent: false,
    occurredAt: new Date('2026-10-08T10:00:00Z'),
    ...over,
  });

  describe('signature (Svix)', () => {
    const body = Buffer.from('{"type":"email.delivered","data":{"email_id":"re-1"}}');
    const now = new Date('2026-10-08T10:00:00Z');
    const ts = String(Math.floor(now.getTime() / 1000));
    const valid = () => ({ id: 'msg_1', timestamp: ts, signature: signSvix(SECRET, 'msg_1', ts, body.toString()), rawBody: body });

    it('accepts a valid signature, including among several (key rotation)', () => {
      expect(verifySvixSignature(SECRET, valid(), now)).toBe(true);
      expect(verifySvixSignature(SECRET, { ...valid(), signature: `v1,Zm9v ${valid().signature}` }, now)).toBe(true);
    });

    it.each([
      ['a missing id', { id: undefined }],
      ['a missing timestamp', { timestamp: undefined }],
      ['a missing signature', { signature: undefined }],
      ['a missing body', { rawBody: undefined }],
      ['a modified body', { rawBody: Buffer.from('{"type":"email.delivered","data":{"email_id":"re-2"}}') }],
      ['a different id', { id: 'msg_2' }],
      ['a malformed signature', { signature: 'v1,not base64 !!' }],
      ['an unknown version', { signature: valid().signature.replace('v1,', 'v2,') }],
      ['a stale timestamp', { timestamp: String(Number(ts) - SVIX_TIMESTAMP_TOLERANCE_SECONDS - 1) }],
      ['a future timestamp', { timestamp: String(Number(ts) + SVIX_TIMESTAMP_TOLERANCE_SECONDS + 1) }],
      ['a non-numeric timestamp', { timestamp: 'yesterday' }],
    ])('rejects %s', (_l, over) => {
      expect(verifySvixSignature(SECRET, { ...valid(), ...over }, now)).toBe(false);
    });

    it('rejects a signature made with another secret', () => {
      const other = `whsec_${Buffer.from('another-secret-another-secret!!!').toString('base64')}`;
      expect(verifySvixSignature(other, valid(), now)).toBe(false);
    });
  });

  describe('parsing', () => {
    it('reads only type, created_at, email_id, to and bounce.type', () => {
      const raw = Buffer.from(JSON.stringify({
        type: 'email.bounced',
        created_at: '2026-10-08T10:00:00.000Z',
        data: { email_id: 're-1', to: [ADDRESS], from: 'x@y.z', subject: 'secret subject', bounce: { type: 'Permanent', subType: 'General', message: 'mailbox gone' }, tags: { a: 'b' } },
      }));
      expect(parseResendEmailEvent(raw)).toEqual({ type: 'email.bounced', occurredAt: new Date('2026-10-08T10:00:00.000Z'), emailId: 're-1', to: [ADDRESS], bounceType: 'Permanent' });
    });

    it.each([
      ['an unsupported type', { type: 'email.opened', data: { email_id: 're-1' } }],
      ['no email_id', { type: 'email.delivered', data: {} }],
      ['an over-long email_id', { type: 'email.delivered', data: { email_id: 'x'.repeat(129) } }],
    ])('ignores %s', (_l, payload) => {
      expect(parseResendEmailEvent(Buffer.from(JSON.stringify(payload)))).toBeNull();
    });

    it('ignores non-JSON; the receipt’s event type is sanitized', () => {
      expect(parseResendEmailEvent(Buffer.from('not json'))).toBeNull();
      expect(eventTypeOf(Buffer.from('not json'))).toBe('unknown');
      expect(eventTypeOf(Buffer.from(JSON.stringify({ type: 'contact.created' })))).toBe('contact.created');
      expect(eventTypeOf(Buffer.from(JSON.stringify({ type: 'x'.repeat(100) })))).toBe('unknown');
    });
  });

  describe('processing', () => {
    it('delivered → one DELIVERED history row for the SENT attempt; the SENT row is preserved', async () => {
      expect(await command.execute(report())).toEqual({ outcome: 'APPLIED' });
      expect(store.attempts.map((a) => [a.attemptNumber, a.status, a.providerMsgId, a.errorCode])).toEqual([
        [1, 'SENT', 're-1', null],
        [1, 'DELIVERED', 're-1', null],
      ]);
    });

    it('the same event twice → DUPLICATE, one effect; a second event with another id adds no duplicate row', async () => {
      const r = report();
      await command.execute(r);
      expect(await command.execute(r)).toEqual({ outcome: 'DUPLICATE' });
      expect(await command.execute(report())).toEqual({ outcome: 'APPLIED' });
      expect(store.attempts.filter((a) => a.status === 'DELIVERED')).toHaveLength(1);
    });

    it('concurrent copies of one event → one APPLIED, one DUPLICATE', async () => {
      const r = report();
      const results = await Promise.all([command.execute(r), command.execute(r), command.execute(r)]);
      expect(results.map((x) => x.outcome).sort()).toEqual(['APPLIED', 'DUPLICATE', 'DUPLICATE']);
      expect(store.attempts.filter((a) => a.status === 'DELIVERED')).toHaveLength(1);
    });

    it('a processing failure keeps no receipt, so the redelivery is applied', async () => {
      const r = report();
      store.failNextEffect = true;
      await expect(command.execute(r)).rejects.toThrow();
      expect(store.receipts.size).toBe(0);
      expect(await command.execute(r)).toEqual({ outcome: 'APPLIED' });
    });

    it('delayed → acknowledged; nothing marked delivered or failed', async () => {
      expect(await command.execute(report({ kind: 'DELAYED', eventType: 'email.delivery_delayed' }))).toEqual({ outcome: 'APPLIED' });
      expect(store.attempts.map((a) => a.status)).toEqual(['SENT']);
    });

    it('a permanent bounce → BOUNCED EMAIL_BOUNCED and the canonical destination suppressed (hashed)', async () => {
      await command.execute(report({ kind: 'BOUNCED', eventType: 'email.bounced', permanent: true }));
      expect(store.attempts.at(-1)).toMatchObject({ status: 'BOUNCED', errorCode: 'EMAIL_BOUNCED' });
      expect([...store.suppressed]).toEqual([[`EMAIL|${suppressionKeyOf(CANONICAL)}`, 'PERMANENT_BOUNCE']]);
      expect(JSON.stringify([...store.suppressed])).not.toMatch(/customer|example/i);
    });

    it('a transient / undetermined bounce → BOUNCED EMAIL_SOFT_BOUNCED, no suppression', async () => {
      await command.execute(report({ kind: 'BOUNCED', eventType: 'email.bounced', permanent: false }));
      expect(store.attempts.at(-1)).toMatchObject({ status: 'BOUNCED', errorCode: 'EMAIL_SOFT_BOUNCED' });
      expect(store.suppressed.size).toBe(0);
    });

    it('a complaint → BOUNCED EMAIL_COMPLAINED and suppression', async () => {
      await command.execute(report({ kind: 'COMPLAINED', eventType: 'email.complained' }));
      expect(store.attempts.at(-1)).toMatchObject({ status: 'BOUNCED', errorCode: 'EMAIL_COMPLAINED' });
      expect([...store.suppressed.values()]).toEqual(['COMPLAINT']);
    });

    it('an unknown email_id → UNMATCHED: receipt only, nothing fabricated, nothing suppressed; logs no address', async () => {
      expect(await command.execute(report({ kind: 'BOUNCED', permanent: true, providerMessageId: 're-unknown' }))).toEqual({ outcome: 'UNMATCHED' });
      expect(store.attempts).toHaveLength(1);
      expect(store.suppressed.size).toBe(0);
      expect(logger.lines.join()).not.toMatch(/customer|example/i);
    });

    it('an ignored event → receipt only', async () => {
      expect(await command.execute(report({ kind: 'IGNORED', eventType: 'email.opened', providerMessageId: null }))).toEqual({ outcome: 'IGNORED' });
      expect(store.attempts).toHaveLength(1);
    });
  });

  describe('send-time suppression', () => {
    type Job = { id: string; notificationId: string; channel: NotificationChannel; status: DeliveryJobStatus; attemptCount: number; nextAttemptAt: Date; lease: Date | null; lastErrorCode: string | null };
    class Queue implements INotificationDeliveryRepository {
      jobs: Job[] = [];
      attempts: NewDeliveryAttempt[] = [];
      async findDeliverable() {
        return { id: 'n-2', recipientUserId: 'user-a', category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.IN_APP, title: 'T', body: 'B' };
      }
      async findDueJobIds(now: Date, channels: readonly NotificationChannel[]) {
        return this.jobs.filter((j) => channels.includes(j.channel) && j.status === 'PENDING' && j.nextAttemptAt <= now).map((j) => j.id);
      }
      async claim(id: string, _now: Date, lease: Date): Promise<ClaimedDeliveryJob | null> {
        const j = this.jobs.find((x) => x.id === id)!;
        j.status = DeliveryJobStatus.PROCESSING;
        return { id, notificationId: j.notificationId, channel: j.channel, attemptCount: j.attemptCount, leaseExpiresAt: lease };
      }
      async settle(c: ClaimedDeliveryJob, s: DeliveryJobSettlement) {
        Object.assign(this.jobs.find((x) => x.id === c.id)!, { status: s.status, attemptCount: s.attemptCount, lastErrorCode: s.lastErrorCode });
        if (s.attempt) this.attempts.push(s.attempt);
        return true;
      }
    }
    const prefs: INotificationPreferenceRepository = { listForUser: async () => [], upsert: async () => undefined };

    it('a suppressed destination is never sent to: job SUPPRESSED with a SUPPRESSED attempt, preference enabled or not', async () => {
      await command.execute(report({ kind: 'COMPLAINED', eventType: 'email.complained' }));
      const transport = new InMemoryEmailTransport();
      const provider = new EmailNotificationProvider(contacts, transport, new DestinationSuppressionService(store), logger);
      const queue = new Queue();
      queue.jobs.push({ id: 'j', notificationId: 'n-2', channel: NotificationChannel.EMAIL, status: DeliveryJobStatus.PENDING, attemptCount: 0, nextAttemptAt: new Date(0), lease: null, lastErrorCode: null });
      const dispatcher = new NotificationDeliveryDispatcher(queue, prefs, new StaticNotificationChannelProviderRegistry([provider]), logger);
      expect((await dispatcher.dispatchDue(new Date())).outcomes).toEqual({ SUPPRESSED: 1 });
      expect(transport.sent).toEqual([]);
      expect(queue.jobs[0]).toMatchObject({ status: 'SUPPRESSED', attemptCount: 0, lastErrorCode: 'EMAIL_DESTINATION_SUPPRESSED' });
      expect(queue.attempts).toEqual([{ attemptNumber: 1, status: 'SUPPRESSED', provider: 'email-in-memory', providerMessageId: null, errorCode: 'EMAIL_DESTINATION_SUPPRESSED' }]);
    });

    it('another destination is unaffected', async () => {
      await command.execute(report({ kind: 'COMPLAINED', eventType: 'email.complained' }));
      const suppression = new DestinationSuppressionService(store);
      expect(await suppression.isSuppressed(NotificationChannel.EMAIL, CANONICAL)).toBe(true);
      expect(await suppression.isSuppressed(NotificationChannel.EMAIL, 'customer.b@example.com')).toBe(false);
      expect(await suppression.isSuppressed(NotificationChannel.SMS, CANONICAL)).toBe(false);
    });

    it('the key is deterministic and case-insensitive through Module 01’s canonical form', () => {
      expect(suppressionKeyOf(CANONICAL)).toBe(suppressionKeyOf(contacts.canonicalEmail(ADDRESS)!));
      expect(suppressionKeyOf(CANONICAL)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });
});
