import { AppLogger } from '../../../shared/logging/app-logger.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { ChannelDecisionReason, evaluateChannel, externalChannelsFor } from '../domain/delivery-policy';
import { DigestFrequency, NotificationCategory, NotificationChannel, NotificationStatus } from '../domain/enums';
import {
  DeliverableNotification,
  DeliveryAttemptRecord,
  INotificationDeliveryRepository,
  NewDeliveryAttempt,
} from '../domain/repositories/notification-delivery.repository';
import {
  INotificationPreferenceRepository,
  StoredChannelPreference,
} from '../domain/repositories/notification-preference.repository';
import { InMemoryNotificationChannelProvider } from '../infrastructure/providers/in-memory-notification-channel.provider';
import { StaticNotificationChannelProviderRegistry } from '../infrastructure/providers/notification-channel-provider.registry';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  INotificationChannelProvider,
} from './ports/outbound/notification-channel-provider.port';
import { NotificationDeliveryService } from './services/notification-delivery.service';

class FakeDeliveryRepository implements INotificationDeliveryRepository {
  notifications = new Map<string, DeliverableNotification>();
  attempts: DeliveryAttemptRecord[] = [];
  async findDeliverable(id: string) {
    const n = this.notifications.get(id);
    return n ? { ...n } : null;
  }
  async listAttempts(id: string) {
    return this.attempts.filter((a) => a.notificationId === id).sort((x, y) => x.attemptNumber - y.attemptNumber);
  }
  async recordAttempt(a: NewDeliveryAttempt) {
    this.attempts.push({ ...a, attemptedAt: new Date() });
  }
}

class FakePreferenceRepository implements INotificationPreferenceRepository {
  rows: Array<StoredChannelPreference & { userId: string }> = [];
  async listForUser(userId: string, category?: NotificationCategory) {
    return this.rows
      .filter((r) => r.userId === userId && (!category || r.category === category))
      .map((r) => ({ category: r.category, channel: r.channel, enabled: r.enabled, digestFrequency: r.digestFrequency }));
  }
  async upsert(): Promise<void> {
    throw new Error('the delivery pipeline never writes preferences');
  }
}

function fakeLogger(): AppLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (m: string) => lines.push(m);
  return { lines, setContext: () => undefined, log: push, warn: push, error: push, debug: push, verbose: push } as unknown as AppLogger & {
    lines: string[];
  };
}

/** Module 13 Work 12: the delivery policy and `NotificationDeliveryService`, with fakes for persistence. */
describe('Notification delivery foundation (application)', () => {
  const USER = 'user-a';
  const N = 'notification-1';
  let deliveries: FakeDeliveryRepository;
  let preferences: FakePreferenceRepository;
  let logger: ReturnType<typeof fakeLogger>;

  const notification = (over: Partial<DeliverableNotification> = {}): DeliverableNotification => ({
    id: N,
    recipientUserId: USER,
    category: NotificationCategory.TRANSACTIONAL,
    channel: NotificationChannel.IN_APP,
    title: 'Order placed',
    body: 'Your order has been placed.',
    ...over,
  });
  const service = (providers: INotificationChannelProvider[] = []) =>
    new NotificationDeliveryService(deliveries, preferences, new StaticNotificationChannelProviderRegistry(providers), logger);
  const prefer = (channel: NotificationChannel, enabled: boolean, category = NotificationCategory.TRANSACTIONAL) =>
    preferences.rows.push({ userId: USER, category, channel, enabled, digestFrequency: DigestFrequency.IMMEDIATE });
  const allSent = () => [
    new InMemoryNotificationChannelProvider(NotificationChannel.PUSH),
    new InMemoryNotificationChannelProvider(NotificationChannel.SMS),
    new InMemoryNotificationChannelProvider(NotificationChannel.EMAIL),
  ];
  const outcomes = (r: Awaited<ReturnType<NotificationDeliveryService['deliver']>>) =>
    r.status === 'PROCESSED' ? r.channels.map((c) => [c.channel, c.outcome]) : r.status;

  beforeEach(() => {
    deliveries = new FakeDeliveryRepository();
    preferences = new FakePreferenceRepository();
    logger = fakeLogger();
    deliveries.notifications.set(N, notification());
  });

  describe('preference evaluation', () => {
    const stored = (enabled: boolean) => ({ enabled, digestFrequency: DigestFrequency.IMMEDIATE });

    it('IN_APP is always allowed — even against a stored disabled preference', () => {
      expect(evaluateChannel(NotificationCategory.TRANSACTIONAL, NotificationChannel.IN_APP, stored(false))).toEqual({
        channel: 'IN_APP', allowed: true, reason: ChannelDecisionReason.POLICY,
      });
    });

    it.each([NotificationChannel.PUSH, NotificationChannel.SMS, NotificationChannel.EMAIL])('a stored disabled %s preference disallows it', (channel) => {
      expect(evaluateChannel(NotificationCategory.TRANSACTIONAL, channel, stored(false))).toEqual({
        channel, allowed: false, reason: ChannelDecisionReason.PREFERENCE_DISABLED,
      });
    });

    it('a missing preference uses the enabled default; a stored one overrides it', () => {
      expect(evaluateChannel(NotificationCategory.SYSTEM, NotificationChannel.SMS, null)).toMatchObject({ allowed: true, reason: 'DEFAULT_ENABLED' });
      expect(evaluateChannel(NotificationCategory.SYSTEM, NotificationChannel.SMS, stored(true))).toMatchObject({ allowed: true, reason: 'PREFERENCE_ENABLED' });
      expect(evaluateChannel(NotificationCategory.SYSTEM, NotificationChannel.SMS, stored(false))).toMatchObject({ allowed: false });
    });

    it('SECURITY follows the configurable policy — it can be disabled like the others', () => {
      expect(evaluateChannel(NotificationCategory.SECURITY, NotificationChannel.EMAIL, stored(false))).toMatchObject({ allowed: false });
      expect(evaluateChannel(NotificationCategory.SECURITY, NotificationChannel.EMAIL, null)).toMatchObject({ allowed: true });
    });

    it.each([
      [NotificationCategory.MARKETING, NotificationChannel.SMS],
      [NotificationCategory.REMINDER, NotificationChannel.PUSH],
      [NotificationCategory.TRANSACTIONAL, 'FAX' as NotificationChannel],
    ])('refuses unsupported %s / %s as a validation error', (category, channel) => {
      let err: unknown;
      try {
        evaluateChannel(category, channel, null);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('only the template categories have external channels, and IN_APP is never one of them', () => {
      for (const c of [NotificationCategory.TRANSACTIONAL, NotificationCategory.SECURITY, NotificationCategory.SYSTEM]) {
        expect(externalChannelsFor(c)).toEqual(['PUSH', 'SMS', 'EMAIL']);
      }
      expect(externalChannelsFor(NotificationCategory.MARKETING)).toEqual([]);
      expect(externalChannelsFor(NotificationCategory.REMINDER)).toEqual([]);
    });
  });

  describe('delivery orchestration', () => {
    it('attempts every enabled channel through its provider, never IN_APP, and records a SENT attempt each', async () => {
      const providers = allSent();
      expect(outcomes(await service(providers).deliver(N))).toEqual([
        ['IN_APP', 'IN_APP_RECORDED'],
        ['PUSH', 'SENT'],
        ['SMS', 'SENT'],
        ['EMAIL', 'SENT'],
      ]);
      expect(providers.map((p) => p.delivered.map((r) => r.channel))).toEqual([['PUSH'], ['SMS'], ['EMAIL']]);
      expect(deliveries.attempts.map((a) => [a.channel, a.status, a.attemptNumber, a.provider, a.providerMessageId, a.errorCode])).toEqual([
        ['PUSH', 'SENT', 1, 'in-memory-push', `in-memory:PUSH:${N}`, null],
        ['SMS', 'SENT', 1, 'in-memory-sms', `in-memory:SMS:${N}`, null],
        ['EMAIL', 'SENT', 1, 'in-memory-email', `in-memory:EMAIL:${N}`, null],
      ]);
      expect(deliveries.attempts.some((a) => a.channel === NotificationChannel.IN_APP)).toBe(false);
    });

    it('hands the provider only the notification id, channel, category, opaque recipient and rendered text', async () => {
      const [push] = allSent();
      await service([push]).deliver(N);
      expect(push.delivered).toEqual([
        { notificationId: N, channel: 'PUSH', category: 'TRANSACTIONAL', recipient: { userId: USER }, title: 'Order placed', body: 'Your order has been placed.' },
      ]);
      expect(Object.isFrozen(push.delivered[0])).toBe(true);
      expect(Object.isFrozen(push.delivered[0].recipient)).toBe(true);
    });

    it('a disabled channel is skipped: SUPPRESSED, PREFERENCE_DISABLED, provider never called', async () => {
      prefer(NotificationChannel.SMS, false);
      const providers = allSent();
      expect(outcomes(await service(providers).deliver(N))).toEqual([
        ['IN_APP', 'IN_APP_RECORDED'],
        ['PUSH', 'SENT'],
        ['SMS', 'SUPPRESSED'],
        ['EMAIL', 'SENT'],
      ]);
      expect(providers[1].delivered).toEqual([]);
      expect(deliveries.attempts.find((a) => a.channel === 'SMS')).toMatchObject({ status: 'SUPPRESSED', provider: null, errorCode: 'PREFERENCE_DISABLED' });
    });

    it('a preference for another category does not apply', async () => {
      prefer(NotificationChannel.PUSH, false, NotificationCategory.SECURITY);
      expect(outcomes(await service(allSent()).deliver(N))).toContainEqual(['PUSH', 'SENT']);
    });

    it('with no provider bound (production today), every allowed channel is a FAILED CHANNEL_NOT_CONFIGURED attempt', async () => {
      prefer(NotificationChannel.EMAIL, false);
      expect(outcomes(await service().deliver(N))).toEqual([
        ['IN_APP', 'IN_APP_RECORDED'],
        ['PUSH', 'NOT_CONFIGURED'],
        ['SMS', 'NOT_CONFIGURED'],
        ['EMAIL', 'SUPPRESSED'],
      ]);
      expect(deliveries.attempts.map((a) => [a.channel, a.status, a.provider, a.errorCode])).toEqual([
        ['PUSH', 'FAILED', null, 'CHANNEL_NOT_CONFIGURED'],
        ['SMS', 'FAILED', null, 'CHANNEL_NOT_CONFIGURED'],
        ['EMAIL', 'SUPPRESSED', null, 'PREFERENCE_DISABLED'],
      ]);
    });

    it('a provider that reports itself unconfigured is NOT_CONFIGURED, under its name', async () => {
      await service([new InMemoryNotificationChannelProvider(NotificationChannel.PUSH, 'NOT_CONFIGURED')]).deliver(N);
      expect(deliveries.attempts[0]).toMatchObject({ channel: 'PUSH', status: 'FAILED', provider: 'in-memory-push', errorCode: 'CHANNEL_NOT_CONFIGURED' });
    });

    it('a provider failure is a FAILED attempt with the provider’s code', async () => {
      const r = await service([new InMemoryNotificationChannelProvider(NotificationChannel.SMS, 'FAILED', 'RECIPIENT_UNREACHABLE')]).deliver(N);
      expect(outcomes(r)).toContainEqual(['SMS', 'FAILED']);
      expect(deliveries.attempts.find((a) => a.channel === 'SMS')).toMatchObject({ status: 'FAILED', errorCode: 'RECIPIENT_UNREACHABLE', errorDetail: null });
    });

    it('a provider that throws is a FAILED PROVIDER_ERROR attempt; the exception text is neither stored nor logged', async () => {
      const secret = 'Bearer sk_live_SECRET +251911000999';
      const thrower: INotificationChannelProvider = {
        name: 'thrower',
        channel: NotificationChannel.EMAIL,
        deliver: async () => {
          throw new Error(secret);
        },
      };
      expect(outcomes(await service([thrower]).deliver(N))).toContainEqual(['EMAIL', 'FAILED']);
      expect(deliveries.attempts.find((a) => a.channel === 'EMAIL')).toMatchObject({ status: 'FAILED', provider: 'thrower', errorCode: 'PROVIDER_ERROR', errorDetail: null });
      expect(JSON.stringify(deliveries.attempts) + logger.lines.join('\n')).not.toContain('sk_live');
      expect(logger.lines.join('\n')).not.toContain('+251');
    });

    it('nothing a provider returns beyond the documented result reaches the attempt — no credential, no free text', async () => {
      const leaky = (result: unknown): INotificationChannelProvider => ({
        name: 'leaky',
        channel: NotificationChannel.PUSH,
        deliver: async () => result as ChannelDeliveryResult,
      });
      await service([leaky({ outcome: 'FAILED', errorCode: 'api key sk_live_SECRET rejected', apiKey: 'sk_live_SECRET', detail: '+251911000999' })]).deliver(N);
      deliveries.attempts = [];
      await service([leaky({ outcome: 'SENT', providerMessageId: 'x'.repeat(500), token: 'refresh-SECRET' })]).deliver(N);
      const sent = deliveries.attempts[0];
      expect(sent.providerMessageId).toHaveLength(128);
      deliveries.attempts = [];
      await service([leaky({ outcome: 'MAYBE' })]).deliver(N);
      expect(deliveries.attempts[0]).toMatchObject({ status: 'FAILED', errorCode: 'PROVIDER_INVALID_RESULT' });
      deliveries.attempts = [];
      await service([leaky({ outcome: 'FAILED', errorCode: 'api key sk_live_SECRET rejected' })]).deliver(N);
      expect(deliveries.attempts[0].errorCode).toBe('PROVIDER_ERROR');
      expect(JSON.stringify(deliveries.attempts)).not.toMatch(/SECRET|\+251|apiKey|token/);
      for (const a of deliveries.attempts) {
        expect(Object.keys(a).sort()).toEqual(
          ['attemptNumber', 'attemptedAt', 'channel', 'errorCode', 'errorDetail', 'notificationId', 'provider', 'providerMessageId', 'status'].sort(),
        );
      }
    });

    it('a provider cannot change the recipient, the text or the notification the attempt is recorded against', async () => {
      const tamperer: INotificationChannelProvider = {
        name: 'tamperer',
        channel: NotificationChannel.PUSH,
        deliver: async (req: ChannelDeliveryRequest) => {
          const r = req as unknown as { recipient: { userId: string }; notificationId: string; title: string };
          try {
            r.recipient.userId = 'attacker';
          } catch { /* frozen */ }
          try {
            r.notificationId = 'other-notification';
          } catch { /* frozen */ }
          try {
            r.title = 'changed';
          } catch { /* frozen */ }
          return { outcome: 'SENT', recipientUserId: 'attacker', notificationId: 'other-notification' } as ChannelDeliveryResult;
        },
      };
      await service([tamperer]).deliver(N);
      expect(deliveries.attempts.map((a) => a.notificationId)).toEqual([N, N, N]);
      expect(await deliveries.findDeliverable(N)).toEqual(notification());
      expect(JSON.stringify(deliveries.attempts)).not.toContain('attacker');
    });

    it.each([
      ['an unknown notification', null, 'NOT_FOUND'],
      ['a non-IN_APP source row', { channel: NotificationChannel.SMS }, 'UNSUPPORTED_SOURCE'],
      ['a MARKETING notification', { category: NotificationCategory.MARKETING }, 'UNSUPPORTED_CATEGORY'],
      ['a REMINDER notification', { category: NotificationCategory.REMINDER }, 'UNSUPPORTED_CATEGORY'],
    ])('%s is refused with no attempt and no provider call', async (_label, over, status) => {
      if (over) deliveries.notifications.set(N, notification(over as Partial<DeliverableNotification>));
      else deliveries.notifications.clear();
      const providers = allSent();
      expect(await service(providers).deliver(N)).toEqual({ status });
      expect(deliveries.attempts).toEqual([]);
      expect(providers.every((p) => p.delivered.length === 0)).toBe(true);
    });
  });

  describe('idempotency and safety', () => {
    it('a repeated call records nothing for settled channels (SENT, SUPPRESSED) and leaves the notification as it was', async () => {
      prefer(NotificationChannel.EMAIL, false);
      const providers = allSent();
      await service(providers).deliver(N);
      const before = JSON.stringify(deliveries.attempts);
      expect(outcomes(await service(providers).deliver(N))).toEqual([
        ['IN_APP', 'IN_APP_RECORDED'],
        ['PUSH', 'ALREADY_SETTLED'],
        ['SMS', 'ALREADY_SETTLED'],
        ['EMAIL', 'ALREADY_SETTLED'],
      ]);
      expect(JSON.stringify(deliveries.attempts)).toBe(before);
      expect(providers.map((p) => p.delivered.length)).toEqual([1, 1, 0]);
      expect(await deliveries.findDeliverable(N)).toEqual(notification());
    });

    it('a FAILED channel is attempted again as attempt n + 1; a later success settles it', async () => {
      await service().deliver(N);
      await service().deliver(N);
      expect(deliveries.attempts.filter((a) => a.channel === 'PUSH').map((a) => [a.attemptNumber, a.status])).toEqual([
        [1, 'FAILED'],
        [2, 'FAILED'],
      ]);
      await service(allSent()).deliver(N);
      await service(allSent()).deliver(N);
      expect(deliveries.attempts.filter((a) => a.channel === 'PUSH').map((a) => [a.attemptNumber, a.status])).toEqual([
        [1, 'FAILED'],
        [2, 'FAILED'],
        [3, 'SENT'],
      ]);
    });

    it('a channel suppressed once stays settled for that notification even if the preference is re-enabled later', async () => {
      prefer(NotificationChannel.SMS, false);
      await service(allSent()).deliver(N);
      preferences.rows = [];
      expect(outcomes(await service(allSent()).deliver(N))).toContainEqual(['SMS', 'ALREADY_SETTLED']);
    });

    it('creates no notification and writes no preference — its ports have no method that could', async () => {
      const r = await service(allSent()).deliver(N);
      expect(r.status).toBe('PROCESSED');
      expect(deliveries.notifications.size).toBe(1);
      expect(preferences.rows).toEqual([]);
      expect(deliveries.attempts.every((a) => a.status !== NotificationStatus.READ)).toBe(true);
    });

    it('the registry refuses an IN_APP provider and two providers for one channel', () => {
      expect(() => new StaticNotificationChannelProviderRegistry([new InMemoryNotificationChannelProvider(NotificationChannel.IN_APP)])).toThrow();
      expect(
        () =>
          new StaticNotificationChannelProviderRegistry([
            new InMemoryNotificationChannelProvider(NotificationChannel.SMS),
            new InMemoryNotificationChannelProvider(NotificationChannel.SMS),
          ]),
      ).toThrow();
    });
  });
});
