import { randomUUID } from 'crypto';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { ChannelDecisionReason, evaluateChannel } from '../domain/delivery-policy';
import { DELIVERY_QUEUE_POLICY, retryDelayAfter } from '../domain/delivery-retry-policy';
import { DeliveryJobStatus, DigestFrequency, NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  ClaimedDeliveryJob,
  DeliverableNotification,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../domain/repositories/notification-delivery.repository';
import { INotificationPreferenceRepository, StoredChannelPreference } from '../domain/repositories/notification-preference.repository';
import { INotificationRepository, NewNotification } from '../domain/repositories/notification.repository';
import { NotificationTemplateCode } from '../domain/templates';
import { InMemoryNotificationChannelProvider, InMemoryProviderBehaviour } from '../infrastructure/providers/in-memory-notification-channel.provider';
import { StaticNotificationChannelProviderRegistry } from '../infrastructure/providers/notification-channel-provider.registry';
import { NotificationDeliveryScheduler } from '../infrastructure/scheduling/notification-delivery.scheduler';
import { RecordNotificationCommand } from './commands/record-notification.command';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
} from './ports/outbound/notification-channel-provider.port';
import { JobOutcome, NotificationDeliveryDispatcher } from './services/notification-delivery.dispatcher';

interface Job {
  id: string;
  notificationId: string;
  channel: NotificationChannel;
  status: DeliveryJobStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  completedAt: Date | null;
}
type Attempt = NewDeliveryAttempt & { notificationId: string; channel: NotificationChannel };

/**
 * `notifications` + `notification_delivery_jobs` + `delivery_attempts` in memory, with the same
 * guarantees the Prisma adapters get from PostgreSQL: one job per (notification, channel), claims
 * that only one caller can win, and settlements fenced on the lease.
 */
class Store implements INotificationDeliveryRepository, Pick<INotificationRepository, 'insertIfAbsent'> {
  notifications = new Map<string, DeliverableNotification & { dedupeKey: string; status: NotificationStatus }>();
  jobs: Job[] = [];
  attempts: Attempt[] = [];
  reads = 0;

  async insertIfAbsent(n: NewNotification, channels: readonly NotificationChannel[] = []): Promise<boolean> {
    if ([...this.notifications.values()].some((x) => x.dedupeKey === n.dedupeKey)) return false;
    const id = randomUUID();
    this.notifications.set(id, { id, recipientUserId: n.recipientUserId, category: n.category, channel: n.channel, title: n.title, body: n.body, dedupeKey: n.dedupeKey, status: n.status });
    for (const channel of channels) this.addJob(id, channel);
    return true;
  }

  addJob(notificationId: string, channel: NotificationChannel, over: Partial<Job> = {}): Job {
    if (this.jobs.some((j) => j.notificationId === notificationId && j.channel === channel)) throw new Error('unique (notificationId, channel)');
    const job: Job = { id: randomUUID(), notificationId, channel, status: DeliveryJobStatus.PENDING, attemptCount: 0, nextAttemptAt: new Date(0), leaseExpiresAt: null, lastErrorCode: null, completedAt: null, ...over };
    this.jobs.push(job);
    return job;
  }

  async findDeliverable(id: string) {
    const n = this.notifications.get(id);
    return n ? { id: n.id, recipientUserId: n.recipientUserId, category: n.category, channel: n.channel, title: n.title, body: n.body } : null;
  }

  private isDue(j: Job, now: Date) {
    return (j.status === DeliveryJobStatus.PENDING && j.nextAttemptAt <= now) || (j.status === DeliveryJobStatus.PROCESSING && !!j.leaseExpiresAt && j.leaseExpiresAt <= now);
  }

  async findDueJobIds(now: Date, channels: readonly NotificationChannel[], limit: number) {
    this.reads++;
    return this.jobs.filter((j) => channels.includes(j.channel) && this.isDue(j, now)).sort((a, b) => +a.nextAttemptAt - +b.nextAttemptAt).slice(0, limit).map((j) => j.id);
  }

  async claim(id: string, now: Date, leaseExpiresAt: Date): Promise<ClaimedDeliveryJob | null> {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !this.isDue(j, now)) return null;
    j.status = DeliveryJobStatus.PROCESSING;
    j.leaseExpiresAt = leaseExpiresAt;
    return { id: j.id, notificationId: j.notificationId, channel: j.channel, attemptCount: j.attemptCount, leaseExpiresAt };
  }

  async settle(c: ClaimedDeliveryJob, s: DeliveryJobSettlement): Promise<boolean> {
    const j = this.jobs.find((x) => x.id === c.id)!;
    if (j.status !== DeliveryJobStatus.PROCESSING || +j.leaseExpiresAt! !== +c.leaseExpiresAt) return false;
    Object.assign(j, { status: s.status, attemptCount: s.attemptCount, leaseExpiresAt: null, lastErrorCode: s.lastErrorCode, completedAt: s.completedAt });
    if (s.nextAttemptAt) j.nextAttemptAt = s.nextAttemptAt;
    if (s.attempt) this.attempts.push({ ...s.attempt, notificationId: c.notificationId, channel: c.channel });
    return true;
  }
}

class Preferences implements INotificationPreferenceRepository {
  rows: Array<StoredChannelPreference & { userId: string }> = [];
  async listForUser(userId: string, category?: NotificationCategory) {
    return this.rows.filter((r) => r.userId === userId && (!category || r.category === category)).map(({ userId: _u, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
  }
  async upsert(): Promise<void> {
    throw new Error('the delivery pipeline never writes preferences');
  }
  set(userId: string, category: NotificationCategory, channel: NotificationChannel, enabled: boolean) {
    this.rows = this.rows.filter((r) => !(r.userId === userId && r.category === category && r.channel === channel));
    this.rows.push({ userId, category, channel, enabled, digestFrequency: DigestFrequency.IMMEDIATE });
  }
}

/** A registry a test can rebind between calls. */
class Registry implements INotificationChannelProviderRegistry {
  inner = new StaticNotificationChannelProviderRegistry([]);
  use(...providers: INotificationChannelProvider[]) {
    this.inner = new StaticNotificationChannelProviderRegistry(providers);
  }
  providerFor(c: NotificationChannel) {
    return this.inner.providerFor(c);
  }
}

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(m);
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & { lines: string[] };
}

/** Module 13 Work 13: queue creation, the dispatcher, retry/lease policy and the scheduler, over in-memory stores. */
describe('Notification delivery queue (application)', () => {
  const USER = 'user-a';
  const T0 = new Date('2026-10-07T10:00:00.000Z');
  const at = (ms: number) => new Date(T0.getTime() + ms);
  let store: Store;
  let prefs: Preferences;
  let registry: Registry;
  let logger: ReturnType<typeof fakeLogger>;
  let dispatcher: NotificationDeliveryDispatcher;
  let record: RecordNotificationCommand;

  beforeEach(() => {
    store = new Store();
    prefs = new Preferences();
    registry = new Registry();
    logger = fakeLogger();
    dispatcher = new NotificationDeliveryDispatcher(store, prefs, registry, logger);
    record = new RecordNotificationCommand(store as unknown as INotificationRepository, { preferredLanguageOf: async () => null }, prefs);
  });

  /** A real recording through Work 01's command (ORDER_PLACED, TRANSACTIONAL). */
  const recordOne = async (eventId = randomUUID(), templateCode = NotificationTemplateCode.ORDER_PLACED) => {
    await record.execute({
      eventId,
      eventType: 'test.event',
      intent: { recipientUserId: USER, templateCode, data: templateCode === NotificationTemplateCode.ORDER_PLACED ? { orderId: 'o-1', grandTotal: 1000, currency: 'ETB' } : {} },
    });
    return [...store.notifications.values()].at(-1)!;
  };
  const jobsOf = (notificationId: string) => store.jobs.filter((j) => j.notificationId === notificationId);
  const provider = (channel: NotificationChannel, behaviour: InMemoryProviderBehaviour = 'SENT', code?: string) =>
    new InMemoryNotificationChannelProvider(channel, behaviour, code);

  describe('policy', () => {
    const stored = (enabled: boolean) => ({ enabled, digestFrequency: DigestFrequency.IMMEDIATE });

    it('IN_APP is always allowed; stored PUSH / SMS / EMAIL preferences decide; missing → enabled default', () => {
      expect(evaluateChannel(NotificationCategory.TRANSACTIONAL, NotificationChannel.IN_APP, stored(false))).toMatchObject({ allowed: true, reason: ChannelDecisionReason.POLICY });
      for (const c of [NotificationChannel.PUSH, NotificationChannel.SMS, NotificationChannel.EMAIL]) {
        expect(evaluateChannel(NotificationCategory.TRANSACTIONAL, c, stored(false))).toMatchObject({ allowed: false });
        expect(evaluateChannel(NotificationCategory.TRANSACTIONAL, c, stored(true))).toMatchObject({ allowed: true, reason: 'PREFERENCE_ENABLED' });
        expect(evaluateChannel(NotificationCategory.TRANSACTIONAL, c, null)).toMatchObject({ allowed: true, reason: 'DEFAULT_ENABLED' });
      }
      expect(evaluateChannel(NotificationCategory.SECURITY, NotificationChannel.SMS, stored(false))).toMatchObject({ allowed: false });
    });

    it.each([
      [NotificationCategory.MARKETING, NotificationChannel.SMS],
      [NotificationCategory.REMINDER, NotificationChannel.PUSH],
      [NotificationCategory.TRANSACTIONAL, 'FAX' as NotificationChannel],
    ])('refuses unsupported %s / %s', (category, channel) => {
      let err: unknown;
      try {
        evaluateChannel(category, channel, null);
      } catch (e) {
        err = e;
      }
      expect((err as ApiException).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('the retry policy: 30 s, 2 min, 10 min, 30 min, then exhausted after the fifth failure', () => {
      expect([1, 2, 3, 4, 5, 6].map(retryDelayAfter)).toEqual([30_000, 120_000, 600_000, 1_800_000, null, null]);
      expect(DELIVERY_QUEUE_POLICY).toMatchObject({ maxProviderAttempts: 5, dispatchIntervalMs: 5_000, dispatchBatchSize: 20 });
      expect(Object.isFrozen(DELIVERY_QUEUE_POLICY)).toBe(true);
    });
  });

  describe('queue creation', () => {
    it('an enabled external channel gets a PENDING job; IN_APP gets none; missing preference → default enabled', async () => {
      const n = await recordOne();
      expect(jobsOf(n.id).map((j) => [j.channel, j.status, j.attemptCount])).toEqual([
        ['PUSH', 'PENDING', 0],
        ['SMS', 'PENDING', 0],
        ['EMAIL', 'PENDING', 0],
      ]);
      expect(store.jobs.some((j) => j.channel === NotificationChannel.IN_APP)).toBe(false);
      expect(n).toMatchObject({ channel: 'IN_APP', status: 'SENT' });
    });

    it('a disabled channel gets no job; a preference of another category does not apply', async () => {
      prefs.set(USER, NotificationCategory.TRANSACTIONAL, NotificationChannel.SMS, false);
      prefs.set(USER, NotificationCategory.SECURITY, NotificationChannel.PUSH, false);
      expect(jobsOf((await recordOne()).id).map((j) => j.channel)).toEqual(['PUSH', 'EMAIL']);
    });

    it('a duplicate recording of the same event creates neither a second notification nor a second job', async () => {
      const eventId = randomUUID();
      await recordOne(eventId);
      await recordOne(eventId);
      await Promise.all([recordOne(eventId), recordOne(eventId)]);
      expect(store.notifications.size).toBe(1);
      expect(store.jobs).toHaveLength(3);
    });

    it('one job per notification and channel', async () => {
      const n = await recordOne();
      expect(() => store.addJob(n.id, NotificationChannel.PUSH)).toThrow('unique');
    });
  });

  describe('dispatch', () => {
    it('with no provider bound, a tick reads nothing and every job stays PENDING with no attempt', async () => {
      const n = await recordOne();
      expect(await dispatcher.dispatchDue(at(0))).toEqual({ due: 0, claimed: 0, outcomes: {} });
      expect(store.reads).toBe(0);
      expect(jobsOf(n.id).every((j) => j.status === 'PENDING' && j.attemptCount === 0 && j.leaseExpiresAt === null)).toBe(true);
      expect(store.attempts).toEqual([]);
    });

    it('a provider SENT result records one SENT attempt #1 and completes the job; DELIVERED likewise', async () => {
      const n = await recordOne();
      const push = provider(NotificationChannel.PUSH);
      registry.use(push, provider(NotificationChannel.SMS, 'DELIVERED'));
      const summary = await dispatcher.dispatchDue(at(0));
      expect(summary).toEqual({ due: 2, claimed: 2, outcomes: { COMPLETED: 2 } });
      expect(store.attempts.map((a) => [a.channel, a.attemptNumber, a.status, a.provider, a.providerMessageId, a.errorCode])).toEqual([
        ['PUSH', 1, 'SENT', 'in-memory-push', `in-memory:PUSH:${n.id}`, null],
        ['SMS', 1, 'DELIVERED', 'in-memory-sms', `in-memory:SMS:${n.id}`, null],
      ]);
      expect(jobsOf(n.id).map((j) => [j.channel, j.status, j.attemptCount, j.completedAt?.toISOString() ?? null])).toEqual([
        ['PUSH', 'COMPLETED', 1, T0.toISOString()],
        ['SMS', 'COMPLETED', 1, T0.toISOString()],
        ['EMAIL', 'PENDING', 0, null],
      ]);
      // Terminal success is never retried.
      await dispatcher.dispatchDue(at(DELIVERY_QUEUE_POLICY.leaseMs * 10));
      expect(push.delivered).toHaveLength(1);
      expect(store.attempts).toHaveLength(2);
    });

    it('hands the provider only id, channel, category, opaque recipient and rendered text — frozen', async () => {
      const n = await recordOne();
      const push = provider(NotificationChannel.PUSH);
      registry.use(push);
      await dispatcher.dispatchDue(at(0));
      expect(push.delivered).toEqual([{ notificationId: n.id, channel: 'PUSH', category: 'TRANSACTIONAL', recipient: { userId: USER }, title: n.title, body: n.body }]);
      expect(Object.isFrozen(push.delivered[0]) && Object.isFrozen(push.delivered[0].recipient)).toBe(true);
    });

    it('a channel disabled after queuing becomes SUPPRESSED with a SUPPRESSED attempt and no provider call; it stays suppressed if re-enabled', async () => {
      const n = await recordOne();
      prefs.set(USER, NotificationCategory.TRANSACTIONAL, NotificationChannel.PUSH, false);
      const push = provider(NotificationChannel.PUSH);
      registry.use(push);
      expect((await dispatcher.dispatchDue(at(0))).outcomes).toEqual({ SUPPRESSED: 1 });
      expect(push.delivered).toEqual([]);
      expect(jobsOf(n.id)[0]).toMatchObject({ status: 'SUPPRESSED', attemptCount: 0, lastErrorCode: 'PREFERENCE_DISABLED' });
      expect(store.attempts).toEqual([{ notificationId: n.id, channel: 'PUSH', attemptNumber: 1, status: 'SUPPRESSED', provider: null, providerMessageId: null, errorCode: 'PREFERENCE_DISABLED' }]);
      prefs.set(USER, NotificationCategory.TRANSACTIONAL, NotificationChannel.PUSH, true);
      await dispatcher.dispatchDue(at(DELIVERY_QUEUE_POLICY.leaseMs * 10));
      expect(push.delivered).toEqual([]);
      // …and a later, unrelated notification is not suppressed by it.
      const later = await recordOne();
      await dispatcher.dispatchDue(at(DELIVERY_QUEUE_POLICY.leaseMs * 20));
      expect(jobsOf(later.id).find((j) => j.channel === 'PUSH')).toMatchObject({ status: 'COMPLETED' });
    });

    it('a channel re-enabled before dispatch proceeds normally', async () => {
      prefs.set(USER, NotificationCategory.TRANSACTIONAL, NotificationChannel.SMS, true);
      const n = await recordOne();
      prefs.set(USER, NotificationCategory.TRANSACTIONAL, NotificationChannel.SMS, false);
      prefs.set(USER, NotificationCategory.TRANSACTIONAL, NotificationChannel.SMS, true);
      registry.use(provider(NotificationChannel.SMS));
      await dispatcher.dispatchDue(at(0));
      expect(jobsOf(n.id).find((j) => j.channel === 'SMS')).toMatchObject({ status: 'COMPLETED' });
    });

    it.each<[string, InMemoryProviderBehaviour, string]>([
      ['FAILED', 'FAILED', 'DEVICE_UNREGISTERED'],
      ['a throw', 'THROW', 'PROVIDER_ERROR'],
      ['an invalid result', 'INVALID', 'PROVIDER_INVALID_RESULT'],
    ])('%s records a FAILED attempt and schedules the retry 30 s out', async (_label, behaviour, code) => {
      const n = await recordOne();
      registry.use(provider(NotificationChannel.EMAIL, behaviour, 'DEVICE_UNREGISTERED'));
      expect((await dispatcher.dispatchDue(at(0))).outcomes).toEqual({ RETRY_SCHEDULED: 1 });
      expect(store.attempts).toEqual([{ notificationId: n.id, channel: 'EMAIL', attemptNumber: 1, status: 'FAILED', provider: 'in-memory-email', providerMessageId: null, errorCode: code }]);
      expect(jobsOf(n.id).find((j) => j.channel === 'EMAIL')).toMatchObject({ status: 'PENDING', attemptCount: 1, lastErrorCode: code, nextAttemptAt: at(30_000), leaseExpiresAt: null });
      // Not due before its time.
      expect((await dispatcher.dispatchDue(at(29_999))).due).toBe(0);
    });

    it('five failures exhaust the job on the schedule; no sixth provider call', async () => {
      const n = await recordOne();
      const sms = provider(NotificationChannel.SMS, 'FAILED', 'UNREACHABLE');
      registry.use(sms);
      let t = 0;
      const seen: Array<[number, string, number]> = [];
      for (let i = 0; i < 5; i++) {
        await dispatcher.dispatchDue(at(t));
        const job = jobsOf(n.id).find((j) => j.channel === 'SMS')!;
        seen.push([job.attemptCount, job.status, +job.nextAttemptAt - +at(t)]);
        t = +job.nextAttemptAt - +T0;
      }
      expect(seen).toEqual([
        [1, 'PENDING', 30_000],
        [2, 'PENDING', 120_000],
        [3, 'PENDING', 600_000],
        [4, 'PENDING', 1_800_000],
        [5, 'EXHAUSTED', expect.any(Number)],
      ]);
      await dispatcher.dispatchDue(at(t + 86_400_000));
      expect(sms.delivered).toHaveLength(5);
      expect(store.attempts.map((a) => [a.attemptNumber, a.status])).toEqual([1, 2, 3, 4, 5].map((k) => [k, 'FAILED']));
      expect(jobsOf(n.id).find((j) => j.channel === 'SMS')).toMatchObject({ status: 'EXHAUSTED', lastErrorCode: 'UNREACHABLE' });
    });

    it('a provider reporting itself unconfigured releases the job: no attempt, no retry used, rechecked later', async () => {
      const n = await recordOne();
      registry.use(provider(NotificationChannel.PUSH, 'NOT_CONFIGURED'));
      expect((await dispatcher.dispatchDue(at(0))).outcomes).toEqual({ RELEASED: 1 });
      expect(store.attempts).toEqual([]);
      expect(jobsOf(n.id)[0]).toMatchObject({ status: 'PENDING', attemptCount: 0, nextAttemptAt: at(DELIVERY_QUEUE_POLICY.notConfiguredRecheckMs) });
      registry.use(provider(NotificationChannel.PUSH));
      await dispatcher.dispatchDue(at(DELIVERY_QUEUE_POLICY.notConfiguredRecheckMs));
      expect(store.attempts.map((a) => [a.attemptNumber, a.status])).toEqual([[1, 'SENT']]);
    });

    it('a job waiting with no provider goes out once a provider is bound — no recreation needed', async () => {
      const n = await recordOne();
      await dispatcher.dispatchDue(at(0));
      await dispatcher.dispatchDue(at(60_000));
      registry.use(provider(NotificationChannel.EMAIL));
      await dispatcher.dispatchDue(at(120_000));
      expect(jobsOf(n.id).find((j) => j.channel === 'EMAIL')).toMatchObject({ status: 'COMPLETED', attemptCount: 1 });
    });

    it('a job whose notification is no longer deliverable is closed EXHAUSTED with no attempt and no provider call', async () => {
      const n = await recordOne();
      store.notifications.delete(n.id);
      const push = provider(NotificationChannel.PUSH);
      registry.use(push);
      expect((await dispatcher.dispatchDue(at(0))).outcomes).toEqual({ NOT_DELIVERABLE: 1 });
      expect(push.delivered).toEqual([]);
      expect(store.attempts).toEqual([]);
      expect(jobsOf(n.id)[0]).toMatchObject({ status: 'EXHAUSTED', lastErrorCode: 'NOT_DELIVERABLE' });
    });
  });

  describe('concurrency', () => {
    /** A provider whose calls wait for the test to release them. */
    const gated = (channel: NotificationChannel) => {
      const calls: ChannelDeliveryRequest[] = [];
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const p: INotificationChannelProvider = {
        name: 'gated',
        channel,
        deliver: async (req) => {
          calls.push(req);
          await gate;
          return { outcome: 'FAILED', errorCode: 'TRANSIENT' };
        },
      };
      return { p, calls, open };
    };

    it('two dispatchers cannot process the same job: one provider call, one attempt, sequential numbers', async () => {
      const n = await recordOne();
      const { p, calls, open } = gated(NotificationChannel.PUSH);
      registry.use(p);
      const other = new NotificationDeliveryDispatcher(store, prefs, registry, logger);
      const both = Promise.all([dispatcher.dispatchDue(at(0)), other.dispatchDue(at(0))]);
      await new Promise((r) => setImmediate(r));
      open();
      const [a, b] = await both;
      expect(a.claimed + b.claimed).toBe(1);
      expect(calls).toHaveLength(1);
      expect(store.attempts.map((x) => x.attemptNumber)).toEqual([1]);
      await Promise.all([dispatcher.dispatchDue(at(30_000)), other.dispatchDue(at(30_000))]);
      expect(store.attempts.filter((x) => x.notificationId === n.id).map((x) => x.attemptNumber)).toEqual([1, 2]);
    });

    it('an abandoned PROCESSING job is reclaimed after its lease; the stale worker’s late settlement is discarded', async () => {
      const n = await recordOne();
      registry.use(provider(NotificationChannel.SMS));
      const stale = await store.claim(jobsOf(n.id).find((j) => j.channel === 'SMS')!.id, at(0), at(DELIVERY_QUEUE_POLICY.leaseMs));
      expect(stale).not.toBeNull();
      // While the lease holds, nobody else gets it.
      expect((await dispatcher.dispatchDue(at(DELIVERY_QUEUE_POLICY.leaseMs - 1))).due).toBe(0);
      // After it lapses, the job is due again and is delivered once.
      expect((await dispatcher.dispatchDue(at(DELIVERY_QUEUE_POLICY.leaseMs))).outcomes).toEqual({ COMPLETED: 1 });
      // The crashed worker wakes up: its write is fenced off.
      expect(
        await store.settle(stale!, { status: DeliveryJobStatus.COMPLETED, attemptCount: 1, lastErrorCode: null, completedAt: at(0), attempt: { attemptNumber: 1, status: NotificationStatus.SENT, provider: 'stale', providerMessageId: null, errorCode: null } }),
      ).toBe(false);
      expect(store.attempts.map((a) => [a.attemptNumber, a.provider])).toEqual([[1, 'in-memory-sms']]);
    });

    it('a lease lost mid-send is reported LEASE_LOST and writes nothing', async () => {
      await recordOne();
      const thief: INotificationChannelProvider = {
        name: 'slow',
        channel: NotificationChannel.PUSH,
        deliver: async () => {
          const j = store.jobs.find((x) => x.channel === NotificationChannel.PUSH)!;
          j.leaseExpiresAt = at(999_999); // another worker reclaimed it meanwhile
          return { outcome: 'SENT' };
        },
      };
      registry.use(thief);
      expect((await dispatcher.dispatchDue(at(0))).outcomes).toEqual({ LEASE_LOST: 1 });
      expect(store.attempts).toEqual([]);
    });
  });

  describe('privacy', () => {
    it('no provider free text, exception message, credential or contact data reaches an attempt, a job or the log', async () => {
      const n = await recordOne();
      const secret = 'Bearer sk_live_SECRET +251911000999 a@b.et';
      const leaky = (channel: NotificationChannel, result: () => Promise<unknown>): INotificationChannelProvider => ({ name: `leaky-${channel}`, channel, deliver: result as () => Promise<ChannelDeliveryResult> });
      registry.use(
        leaky(NotificationChannel.PUSH, async () => {
          throw new Error(secret);
        }),
        leaky(NotificationChannel.SMS, async () => ({ outcome: 'FAILED', errorCode: `api key ${secret}`, apiKey: 'sk_live_SECRET', detail: secret })),
        leaky(NotificationChannel.EMAIL, async () => ({ outcome: 'SENT', providerMessageId: 'x'.repeat(500), token: 'refresh-SECRET', to: 'a@b.et' })),
      );
      await dispatcher.dispatchDue(at(0));
      const persisted = JSON.stringify(store.attempts) + JSON.stringify(store.jobs) + logger.lines.join('\n');
      expect(persisted).not.toMatch(/SECRET|\+251|a@b\.et|apiKey|token/);
      expect(store.attempts.map((a) => [a.channel, a.errorCode])).toEqual([
        ['PUSH', 'PROVIDER_ERROR'],
        ['SMS', 'PROVIDER_ERROR'],
        ['EMAIL', null],
      ]);
      expect(store.attempts.find((a) => a.channel === 'EMAIL')!.providerMessageId).toHaveLength(128);
      for (const j of jobsOf(n.id)) expect(Object.keys(j).sort()).toEqual(['attemptCount', 'channel', 'completedAt', 'id', 'lastErrorCode', 'leaseExpiresAt', 'nextAttemptAt', 'notificationId', 'status']);
    });

    it('a provider cannot change the recipient, the text or the notification an attempt is recorded against', async () => {
      const n = await recordOne();
      const tamperer: INotificationChannelProvider = {
        name: 'tamperer',
        channel: NotificationChannel.PUSH,
        deliver: async (req) => {
          const r = req as unknown as { recipient: { userId: string }; notificationId: string };
          try {
            r.recipient.userId = 'attacker';
          } catch {
            /* frozen */
          }
          try {
            r.notificationId = 'other';
          } catch {
            /* frozen */
          }
          return { outcome: 'SENT', recipientUserId: 'attacker' } as ChannelDeliveryResult;
        },
      };
      registry.use(tamperer);
      await dispatcher.dispatchDue(at(0));
      expect(store.attempts.map((a) => a.notificationId)).toEqual([n.id]);
      expect(await store.findDeliverable(n.id)).toMatchObject({ recipientUserId: USER });
      expect(JSON.stringify(store.attempts)).not.toContain('attacker');
    });
  });

  describe('scheduler', () => {
    it('a tick processes only due jobs, respects the batch size, and never looks at notifications without a job', async () => {
      for (let i = 0; i < 25; i++) await recordOne();
      const historical = randomUUID();
      store.notifications.set(historical, { id: historical, recipientUserId: USER, category: NotificationCategory.TRANSACTIONAL, channel: NotificationChannel.IN_APP, title: 't', body: 'b', dedupeKey: 'old', status: NotificationStatus.SENT });
      const notYet = await recordOne();
      for (const j of jobsOf(notYet.id)) j.nextAttemptAt = new Date(Date.now() + 3_600_000);
      const push = provider(NotificationChannel.PUSH);
      registry.use(push);
      const scheduler = new NotificationDeliveryScheduler(dispatcher, logger);

      const first = await scheduler.tick();
      expect(first).toMatchObject({ due: DELIVERY_QUEUE_POLICY.dispatchBatchSize, claimed: DELIVERY_QUEUE_POLICY.dispatchBatchSize });
      const second = await scheduler.tick();
      expect(second).toMatchObject({ claimed: 5 });
      expect(await scheduler.tick()).toMatchObject({ due: 0 });
      expect(push.delivered.map((r) => r.notificationId)).not.toContain(historical);
      expect(push.delivered.map((r) => r.notificationId)).not.toContain(notYet.id);
      expect(push.delivered).toHaveLength(25);
      expect(store.jobs.filter((j) => j.notificationId === historical)).toEqual([]);
    });

    it('a tick never overlaps another, never throws, and does nothing once shutting down', async () => {
      await recordOne();
      let release!: () => void;
      const slow: INotificationChannelProvider = { name: 'slow', channel: NotificationChannel.PUSH, deliver: () => new Promise((r) => (release = () => r({ outcome: 'SENT' }))) };
      registry.use(slow);
      const scheduler = new NotificationDeliveryScheduler(dispatcher, logger);
      const first = scheduler.tick();
      await new Promise((r) => setImmediate(r));
      expect(await scheduler.tick()).toBeNull();
      release();
      expect((await first)!.claimed).toBe(1);

      const broken = new NotificationDeliveryScheduler({ dispatchDue: () => Promise.reject(new Error('db down')) } as unknown as NotificationDeliveryDispatcher, logger);
      await expect(broken.tick()).resolves.toBeNull();
      scheduler.onApplicationShutdown();
      expect(await scheduler.tick()).toBeNull();
      expect(JobOutcome.COMPLETED).toBe('COMPLETED');
    });
  });
});
