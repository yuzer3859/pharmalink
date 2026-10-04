import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Module 16's domain events (module-16 §5, `00-domain-event-catalog.md`'s Module 16 row).
 *
 * Both events below are already in the catalogue — `ConfigChanged` with payload "namespace, key,
 * version" and consumers "all (cache invalidate via IConfigPort)", and `FeatureFlagToggled` with
 * "key, enabled". They are implemented to that contract rather than invented here, and the
 * catalogue row is widened only where this work found a field a consumer genuinely needs.
 */
export const AdminEventType = {
  ConfigChanged: 'admin.config.changed',
  FeatureFlagToggled: 'admin.feature_flag.toggled',
} as const;

export type AdminEventType = (typeof AdminEventType)[keyof typeof AdminEventType];

/**
 * **What a configuration change publishes — and what it deliberately does not.**
 *
 * The catalogue's payload is `namespace, key, version`, and that is nearly all of it. `changedBy`
 * is added because a consumer reconstructing "who changed what when" from the event stream
 * otherwise has to join back to the audit log for a field that costs eight bytes to carry.
 *
 * **The value itself is not in the payload.** This is a deliberate refusal, and the reason is
 * §12's: an event crosses a boundary that a configuration value need not cross. Every consumer's
 * stated job is to *invalidate a cache* and then re-read through `IConfigPort` — for which the
 * identity of the changed key is sufficient and the value is surplus. Carrying it would put
 * platform configuration into the outbox table, into every subscriber's logs, and into whatever a
 * future relay forwards it to, for no capability anybody asked for. A key is not a secret; a
 * growing pile of copies of every value the platform has ever held is a liability.
 */
export interface ConfigChangedPayload {
  namespace: string;
  key: string;
  /** The version now in force. */
  version: number;
  /** `users.id` of the administrator who published it. */
  changedBy: string;
}

/**
 * A feature flag's on/off state changed.
 *
 * `enabled` *is* carried, unlike a config value, and the asymmetry is principled: a flag's entire
 * content is one boolean that is already public in its effect — a consumer can observe whether the
 * feature works — so the payload reveals nothing the behaviour does not. There is no equivalent
 * argument for a fee or a credential-shaped string.
 */
export interface FeatureFlagToggledPayload {
  key: string;
  enabled: boolean;
  changedBy: string;
}

/**
 * `aggregateType: 'PlatformConfig'`, `aggregateId: '<namespace>.<key>'`.
 *
 * The dotted path rather than the row's uuid, because the aggregate a consumer cares about is *the
 * setting*, not the particular version row. A cache invalidator keyed by row id would have to
 * resolve it back to a path before it could do anything.
 */
export function configChangedEvent(
  payload: ConfigChangedPayload,
): DomainEvent<ConfigChangedPayload> {
  return createDomainEvent({
    type: AdminEventType.ConfigChanged,
    aggregateType: 'PlatformConfig',
    aggregateId: `${payload.namespace}.${payload.key}`,
    payload,
  });
}

export function featureFlagToggledEvent(
  payload: FeatureFlagToggledPayload,
): DomainEvent<FeatureFlagToggledPayload> {
  return createDomainEvent({
    type: AdminEventType.FeatureFlagToggled,
    aggregateType: 'FeatureFlag',
    aggregateId: payload.key,
    payload,
  });
}
