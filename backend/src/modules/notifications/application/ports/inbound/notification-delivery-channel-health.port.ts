import { Inject, Injectable } from '@nestjs/common';
import { ageSeconds, claimStartedAt } from '../../../domain/delivery-queue-health';
import { DeliveryJobStatus, NotificationChannel } from '../../../domain/enums';
import { CONFIGURABLE_CHANNELS, ConfigurableChannel } from '../../../domain/preferences';
import {
  DELIVERY_CHANNEL_HEALTH_REPOSITORY,
  IDeliveryChannelHealthRepository,
} from '../../../domain/repositories/delivery-channel-health.repository';
import {
  channelsWithProvider,
  INotificationChannelProviderRegistry,
  NOTIFICATION_CHANNEL_PROVIDER_REGISTRY,
} from '../outbound/notification-channel-provider.port';

export const NOTIFICATION_DELIVERY_CHANNEL_HEALTH_PORT = Symbol('NOTIFICATION_DELIVERY_CHANNEL_HEALTH_PORT');

/**
 * One delivery channel's health at `generatedAt` (module-16 Work 24): the Work 22 figures for that
 * channel's jobs alone, plus whether the channel can be attempted at all.
 *
 *  - `providerConfigured`  a provider is bound for the channel — exactly the dispatcher's own gate
 *                          (`channelsWithProvider`): it is bound only when its transport reported
 *                          itself configured at startup. `false` means the dispatcher never reads
 *                          the channel's jobs and they wait `PENDING`. A boolean only: no credential,
 *                          sender, project, endpoint or provider name, and no network call.
 *  - `jobs`                per Work 13 status; `total` their sum
 *  - `backlog`             `PENDING` jobs, the oldest's `createdAt` and its age
 *  - `processing`          `PROCESSING` jobs; `staleProcessingCount` those whose lease has lapsed
 *                          (the shared lapsed-lease rule, the dispatcher's own); the oldest claim's
 *                          start (`leaseExpiresAt − leaseMs`) and its age
 *
 * Ages are whole seconds to `generatedAt`, never negative; `null` with no such job.
 */
export interface DeliveryChannelHealth {
  channel: ConfigurableChannel;
  providerConfigured: boolean;
  jobs: { total: number; pending: number; processing: number; completed: number; suppressed: number; exhausted: number };
  backlog: { pendingCount: number; oldestPendingCreatedAt: Date | null; oldestPendingAgeSeconds: number | null };
  processing: {
    processingCount: number;
    staleProcessingCount: number;
    oldestProcessingStartedAt: Date | null;
    oldestProcessingAgeSeconds: number | null;
  };
}

/** Every delivery channel — PUSH, SMS, EMAIL, in that order — always present, from one snapshot. */
export interface DeliveryChannelHealthSnapshot {
  generatedAt: Date;
  channels: DeliveryChannelHealth[];
}

/**
 * Module 13's exported, read-only contract for per-channel queue health and provider readiness
 * (module-16 Work 24), consumed in-process by Module 16. Separate from the Work 20 read port, the
 * Work 22 whole-queue health port and the Work 21 / Work 23 mutation ports. Observation only.
 */
export interface INotificationDeliveryChannelHealthPort {
  channelHealth(): Promise<DeliveryChannelHealthSnapshot>;
}

/** `INotificationDeliveryChannelHealthPort` over Module 13's aggregate repository and provider registry. */
@Injectable()
export class NotificationDeliveryChannelHealthPortAdapter implements INotificationDeliveryChannelHealthPort {
  constructor(
    @Inject(DELIVERY_CHANNEL_HEALTH_REPOSITORY) private readonly jobs: IDeliveryChannelHealthRepository,
    @Inject(NOTIFICATION_CHANNEL_PROVIDER_REGISTRY) private readonly providers: INotificationChannelProviderRegistry,
  ) {}

  async channelHealth(): Promise<DeliveryChannelHealthSnapshot> {
    const generatedAt = new Date();
    const a = await this.jobs.channelAggregatesAt(generatedAt);
    const ready = new Set<NotificationChannel>(channelsWithProvider(this.providers));
    const channels = CONFIGURABLE_CHANNELS.map((channel): DeliveryChannelHealth => {
      const count = (s: DeliveryJobStatus) => a.byChannelAndStatus.find((g) => g.channel === channel && g.status === s)?.count ?? 0;
      const jobs = {
        total: a.byChannelAndStatus.filter((g) => g.channel === channel).reduce((n, g) => n + g.count, 0),
        pending: count(DeliveryJobStatus.PENDING),
        processing: count(DeliveryJobStatus.PROCESSING),
        completed: count(DeliveryJobStatus.COMPLETED),
        suppressed: count(DeliveryJobStatus.SUPPRESSED),
        exhausted: count(DeliveryJobStatus.EXHAUSTED),
      };
      const oldestPendingCreatedAt = a.oldestPendingCreatedAt.find((g) => g.channel === channel)?.at ?? null;
      const oldestProcessingStartedAt = claimStartedAt(a.oldestProcessingLeaseExpiresAt.find((g) => g.channel === channel)?.at ?? null);
      return {
        channel,
        providerConfigured: ready.has(channel),
        jobs,
        backlog: {
          pendingCount: jobs.pending,
          oldestPendingCreatedAt,
          oldestPendingAgeSeconds: ageSeconds(oldestPendingCreatedAt, generatedAt),
        },
        processing: {
          processingCount: jobs.processing,
          staleProcessingCount: a.staleProcessing.find((g) => g.channel === channel)?.count ?? 0,
          oldestProcessingStartedAt,
          oldestProcessingAgeSeconds: ageSeconds(oldestProcessingStartedAt, generatedAt),
        },
      };
    });
    return { generatedAt, channels };
  }
}
