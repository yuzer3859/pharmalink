import { NotificationErrors } from './errors';
import { NotificationCategory, NotificationChannel } from './enums';
import {
  CONFIGURABLE_CHANNELS,
  ChannelPreferenceValue,
  ConfigurableChannel,
  isConfigurableCategory,
  PreferenceSource,
  resolveChannelPreference,
} from './preferences';

/**
 * Delivery policy (module-13 Work 12): which channels a notification may go out on, decided from
 * Work 11's preferences and nothing else.
 *
 * - `IN_APP` is always allowed and never goes through a provider: the notification row *is* the
 *   in-app delivery, written `SENT` when the event is recorded (Works 01–10, unchanged).
 * - `PUSH`, `SMS` and `EMAIL` follow `resolveChannelPreference`: a stored row wins, otherwise the
 *   default (enabled, IMMEDIATE). `SECURITY` is as configurable as the other two categories.
 * - Only the categories the templates emit (`TRANSACTIONAL`, `SECURITY`, `SYSTEM`) have a delivery
 *   path. `REMINDER` and `MARKETING` are refused, exactly as Work 11's API refuses them.
 *
 * Quiet hours and digest cadence are not applied here: `digestFrequency` is reported, not acted on.
 * Work 13 applies these rules twice: when queuing (`channelsToEnqueue`) and again before each send.
 */

/** Why a channel was allowed or not. */
export enum ChannelDecisionReason {
  /** `IN_APP` — fixed by policy. */
  POLICY = 'POLICY',
  /** The user's stored preference enables it. */
  PREFERENCE_ENABLED = 'PREFERENCE_ENABLED',
  /** Nothing stored; the default enables it. */
  DEFAULT_ENABLED = 'DEFAULT_ENABLED',
  /** The user's stored preference disables it. */
  PREFERENCE_DISABLED = 'PREFERENCE_DISABLED',
}

export interface ChannelDecision {
  channel: NotificationChannel;
  allowed: boolean;
  reason: ChannelDecisionReason;
}

/** The external channels a notification of this category is considered for. */
export function externalChannelsFor(category: NotificationCategory): readonly ConfigurableChannel[] {
  return isConfigurableCategory(category) ? CONFIGURABLE_CHANNELS : [];
}

/**
 * Whether one channel may carry a notification of `category`, given the user's stored preference
 * for that (category, channel), or `null`. An unsupported category or an unknown channel is a
 * validation error, never a silent "allowed".
 */
export function evaluateChannel(
  category: NotificationCategory,
  channel: NotificationChannel,
  stored: ChannelPreferenceValue | null,
): ChannelDecision {
  if (!isConfigurableCategory(category)) throw NotificationErrors.preferenceNotConfigurable({ category });
  if (!(Object.values(NotificationChannel) as string[]).includes(channel)) {
    throw NotificationErrors.preferenceNotConfigurable({ category, channel });
  }
  const effective = resolveChannelPreference(channel, stored);
  if (effective.source === PreferenceSource.POLICY) return { channel, allowed: true, reason: ChannelDecisionReason.POLICY };
  if (!effective.enabled) return { channel, allowed: false, reason: ChannelDecisionReason.PREFERENCE_DISABLED };
  return {
    channel,
    allowed: true,
    reason:
      effective.source === PreferenceSource.STORED ? ChannelDecisionReason.PREFERENCE_ENABLED : ChannelDecisionReason.DEFAULT_ENABLED,
  };
}

/**
 * The `delivery_attempts.errorCode` values the pipeline writes itself. Codes a provider reports
 * are kept only when they match `PROVIDER_ERROR_CODE`; anything else becomes `PROVIDER_ERROR`.
 */
export const DeliveryErrorCode = {
  /** The preference disabled the channel; recorded `SUPPRESSED`, no provider called. */
  PREFERENCE_DISABLED: 'PREFERENCE_DISABLED',
  /**
   * A job whose notification can no longer be delivered (gone, not an in-app source row, or an
   * unsupported category). Kept on the job only — no attempt, since no provider was asked.
   */
  NOT_DELIVERABLE: 'NOT_DELIVERABLE',
  /** The provider threw, or reported a failure without a usable code. Recorded `FAILED`. */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** The provider returned something that is not a delivery result. Recorded `FAILED`. */
  PROVIDER_INVALID_RESULT: 'PROVIDER_INVALID_RESULT',
} as const;

export const PROVIDER_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The external channels to queue a delivery job for when a notification is recorded (Work 13):
 * those the user's preference allows *now*. A disabled channel gets no job; the dispatcher
 * re-evaluates the preference before each send, so a later change is still honoured.
 */
export function channelsToEnqueue(
  category: NotificationCategory,
  stored: ReadonlyArray<ChannelPreferenceValue & { channel: NotificationChannel }>,
): NotificationChannel[] {
  return externalChannelsFor(category).filter(
    (channel) => evaluateChannel(category, channel, stored.find((s) => s.channel === channel) ?? null).allowed,
  );
}
