import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { DeliveryErrorCode, evaluateChannel, PROVIDER_ERROR_CODE } from '../../domain/delivery-policy';
import { DELIVERY_QUEUE_POLICY, retryDelayAfter } from '../../domain/delivery-retry-policy';
import { DeliveryJobStatus, NotificationChannel, NotificationStatus } from '../../domain/enums';
import { isConfigurableCategory } from '../../domain/preferences';
import {
  ClaimedDeliveryJob,
  DeliveryJobSettlement,
  INotificationDeliveryRepository,
  NOTIFICATION_DELIVERY_REPOSITORY,
} from '../../domain/repositories/notification-delivery.repository';
import {
  INotificationPreferenceRepository,
  NOTIFICATION_PREFERENCE_REPOSITORY,
} from '../../domain/repositories/notification-preference.repository';
import {
  ChannelDeliveryRequest,
  ChannelDeliveryResult,
  channelsWithProvider,
  INotificationChannelProvider,
  INotificationChannelProviderRegistry,
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
} from '../ports/outbound/notification-channel-provider.port';

/** What one job's processing came to. */
export enum JobOutcome {
  COMPLETED = 'COMPLETED',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  EXHAUSTED = 'EXHAUSTED',
  SUPPRESSED = 'SUPPRESSED',
  /** No provider (or one reporting itself unconfigured): back to PENDING, no attempt, no retry used. */
  RELEASED = 'RELEASED',
  /** Notification gone / not deliverable: closed EXHAUSTED with no attempt. */
  NOT_DELIVERABLE = 'NOT_DELIVERABLE',
  /** The lease expired and another worker took the job; nothing this worker did was written. */
  LEASE_LOST = 'LEASE_LOST',
  /** Unexpected error (e.g. database): the job stays PROCESSING until its lease expires. */
  ERRORED = 'ERRORED',
}

export interface DispatchSummary {
  /** Due jobs found on channels that have a provider. */
  due: number;
  /** Of those, how many this worker claimed (the rest were taken by another worker). */
  claimed: number;
  outcomes: Partial<Record<JobOutcome, number>>;
}

const MAX_PROVIDER_NAME = 64;
const MAX_PROVIDER_MESSAGE_ID = 128;

type ProviderOutcome =
  | { kind: 'SUCCESS'; status: NotificationStatus.SENT | NotificationStatus.DELIVERED; providerMessageId: string | null }
  | { kind: 'FAILURE'; errorCode: string; retryable: boolean }
  | { kind: 'NOT_CONFIGURED' }
  | { kind: 'SUPPRESSED'; code: string };

/**
 * Dispatches due external-delivery jobs (module-13 Work 13). PostgreSQL is the queue: a job is
 * claimed with a single conditional UPDATE and a lease, processed, and settled with a write fenced
 * on that lease — so two dispatchers never process one job, and a worker that died mid-send leaves
 * a job that becomes claimable again when its lease runs out.
 *
 *     channels with a provider? none → return (no query at all)
 *     due jobs on those channels (bounded) → claim each
 *       notification not deliverable                 → EXHAUSTED (NOT_DELIVERABLE), no attempt
 *       current preference disables the channel      → SUPPRESSED + SUPPRESSED attempt
 *       provider gone / reports not configured       → PENDING later, no attempt, no retry used
 *       provider says the destination is suppressed  → SUPPRESSED + SUPPRESSED attempt (Work 18)
 *       provider SENT | DELIVERED                    → COMPLETED + attempt n
 *       provider FAILED | throws | invalid result    → attempt n FAILED; PENDING at backoff, or
 *                                                      EXHAUSTED after the 5th — or at once when
 *                                                      the provider says it is not retryable
 *
 * The job is the authority for attempt numbers: attempt n is `attemptCount + 1`, written in the
 * same fenced transaction that sets `attemptCount = n`. Only non-secret, pipeline-controlled values
 * are stored — never a provider's free text or exception message. The notification row is never
 * modified; nothing here touches an `IN_APP` delivery. Not audited, no event published.
 */
@Injectable()
export class NotificationDeliveryDispatcher {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY) private readonly deliveries: INotificationDeliveryRepository,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY) private readonly preferences: INotificationPreferenceRepository,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER_REGISTRY) private readonly providers: INotificationChannelProviderRegistry,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(NotificationDeliveryDispatcher.name);
  }

  async dispatchDue(now: Date = new Date(), limit: number = DELIVERY_QUEUE_POLICY.dispatchBatchSize): Promise<DispatchSummary> {
    const summary: DispatchSummary = { due: 0, claimed: 0, outcomes: {} };
    // Jobs on a channel with no provider are not even read: they wait, untouched, for one to exist.
    const configured = channelsWithProvider(this.providers);
    if (configured.length === 0) return summary;

    const ids = await this.deliveries.findDueJobIds(now, configured, limit);
    summary.due = ids.length;
    for (const id of ids) {
      const job = await this.deliveries.claim(id, now, new Date(now.getTime() + DELIVERY_QUEUE_POLICY.leaseMs));
      if (!job) continue;
      summary.claimed += 1;
      const outcome = await this.process(job, now);
      summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    }
    return summary;
  }

  private async process(job: ClaimedDeliveryJob, now: Date): Promise<JobOutcome> {
    try {
      const [outcome, settlement] = await this.decide(job, now);
      return (await this.deliveries.settle(job, settlement)) ? outcome : JobOutcome.LEASE_LOST;
    } catch {
      // Not rethrown: one bad job must not stop the batch. Its lease expiring makes it due again.
      this.logger.warn(`delivery job ${job.id} errored; it will be retried after its lease expires`);
      return JobOutcome.ERRORED;
    }
  }

  private async decide(job: ClaimedDeliveryJob, now: Date): Promise<[JobOutcome, DeliveryJobSettlement]> {
    const keep = { attemptCount: job.attemptCount };
    const n = await this.deliveries.findDeliverable(job.notificationId);
    if (!n || n.channel !== NotificationChannel.IN_APP || !isConfigurableCategory(n.category) || job.channel === NotificationChannel.IN_APP) {
      return [
        JobOutcome.NOT_DELIVERABLE,
        { status: DeliveryJobStatus.EXHAUSTED, ...keep, lastErrorCode: DeliveryErrorCode.NOT_DELIVERABLE, completedAt: now, attempt: null },
      ];
    }

    // The preference as it is now — not as it was when the job was queued.
    const stored = await this.preferences.listForUser(n.recipientUserId, n.category);
    const decision = evaluateChannel(n.category, job.channel, stored.find((s) => s.channel === job.channel) ?? null);
    if (!decision.allowed) {
      return [
        JobOutcome.SUPPRESSED,
        {
          status: DeliveryJobStatus.SUPPRESSED,
          ...keep,
          lastErrorCode: DeliveryErrorCode.PREFERENCE_DISABLED,
          completedAt: now,
          attempt: {
            attemptNumber: job.attemptCount + 1,
            status: NotificationStatus.SUPPRESSED,
            provider: null,
            providerMessageId: null,
            errorCode: DeliveryErrorCode.PREFERENCE_DISABLED,
          },
        },
      ];
    }

    const provider = this.providers.providerFor(job.channel);
    const release = (): [JobOutcome, DeliveryJobSettlement] => [
      JobOutcome.RELEASED,
      {
        status: DeliveryJobStatus.PENDING,
        ...keep,
        nextAttemptAt: new Date(now.getTime() + DELIVERY_QUEUE_POLICY.notConfiguredRecheckMs),
        lastErrorCode: null,
        completedAt: null,
        attempt: null,
      },
    ];
    if (!provider) return release();

    const name = String(provider.name).slice(0, MAX_PROVIDER_NAME);
    // Built from the notification, then frozen: whatever the provider does, the recipient and text
    // are the notification's own.
    const request: ChannelDeliveryRequest = Object.freeze({
      notificationId: n.id,
      channel: job.channel,
      category: n.category,
      recipient: Object.freeze({ userId: n.recipientUserId }),
      title: n.title,
      body: n.body,
    });
    const result = await this.invoke(provider, name, request);
    if (result.kind === 'NOT_CONFIGURED') return release();
    if (result.kind === 'SUPPRESSED') {
      return [
        JobOutcome.SUPPRESSED,
        {
          status: DeliveryJobStatus.SUPPRESSED,
          ...keep,
          lastErrorCode: result.code,
          completedAt: now,
          attempt: { attemptNumber: job.attemptCount + 1, status: NotificationStatus.SUPPRESSED, provider: name, providerMessageId: null, errorCode: result.code },
        },
      ];
    }

    const attemptNumber = job.attemptCount + 1;
    if (result.kind === 'SUCCESS') {
      return [
        JobOutcome.COMPLETED,
        {
          status: DeliveryJobStatus.COMPLETED,
          attemptCount: attemptNumber,
          lastErrorCode: null,
          completedAt: now,
          attempt: { attemptNumber, status: result.status, provider: name, providerMessageId: result.providerMessageId, errorCode: null },
        },
      ];
    }

    const delay = result.retryable ? retryDelayAfter(attemptNumber) : null;
    const attempt = { attemptNumber, status: NotificationStatus.FAILED, provider: name, providerMessageId: null, errorCode: result.errorCode };
    if (delay === null) {
      return [
        JobOutcome.EXHAUSTED,
        { status: DeliveryJobStatus.EXHAUSTED, attemptCount: attemptNumber, lastErrorCode: result.errorCode, completedAt: now, attempt },
      ];
    }
    return [
      JobOutcome.RETRY_SCHEDULED,
      {
        status: DeliveryJobStatus.PENDING,
        attemptCount: attemptNumber,
        nextAttemptAt: new Date(now.getTime() + delay),
        lastErrorCode: result.errorCode,
        completedAt: null,
        attempt,
      },
    ];
  }

  /** The provider call, reduced to values safe to store. */
  private async invoke(provider: INotificationChannelProvider, name: string, request: ChannelDeliveryRequest): Promise<ProviderOutcome> {
    let result: ChannelDeliveryResult;
    try {
      result = await provider.deliver(request);
    } catch {
      // The exception's message is not stored or logged: it may carry a credential or an address.
      this.logger.warn(`provider ${name} threw delivering notification ${request.notificationId} on ${request.channel}`);
      return { kind: 'FAILURE', errorCode: DeliveryErrorCode.PROVIDER_ERROR, retryable: true };
    }
    switch (result?.outcome) {
      case 'SENT':
      case 'DELIVERED':
        return {
          kind: 'SUCCESS',
          status: result.outcome === 'SENT' ? NotificationStatus.SENT : NotificationStatus.DELIVERED,
          providerMessageId: typeof result.providerMessageId === 'string' ? result.providerMessageId.slice(0, MAX_PROVIDER_MESSAGE_ID) : null,
        };
      case 'FAILED':
        return {
          kind: 'FAILURE',
          errorCode: typeof result.errorCode === 'string' && PROVIDER_ERROR_CODE.test(result.errorCode) ? result.errorCode : DeliveryErrorCode.PROVIDER_ERROR,
          // Only an explicit `false` stops retries; anything else keeps the Work 13 schedule.
          retryable: result.retryable !== false,
        };
      case 'NOT_CONFIGURED':
        return { kind: 'NOT_CONFIGURED' };
      case 'SUPPRESSED':
        return {
          kind: 'SUPPRESSED',
          code: typeof result.code === 'string' && PROVIDER_ERROR_CODE.test(result.code) ? result.code : DeliveryErrorCode.PREFERENCE_DISABLED,
        };
      default:
        return { kind: 'FAILURE', errorCode: DeliveryErrorCode.PROVIDER_INVALID_RESULT, retryable: true };
    }
  }
}
