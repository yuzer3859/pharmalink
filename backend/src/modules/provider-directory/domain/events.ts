import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/** Work 160: Provider Directory events (module-09 §9), written to the outbox with the change. */
export const ProviderEventType = {
  ProviderActivated: 'provider.provider.activated',
  ProviderSuspended: 'provider.provider.suspended',
  /** Work 161: the profile, a location, its hours or facilities, a department or a service changed. */
  ProviderProfileChanged: 'provider.provider.profile_changed',
} as const;

export interface ProviderActivatedPayload {
  providerId: string;
  organizationId: string;
  type: string;
}

export interface ProviderSuspendedPayload {
  providerId: string;
  reason: 'LICENSE_EXPIRED' | 'MANUAL';
}

export function providerActivatedEvent(payload: ProviderActivatedPayload): DomainEvent<ProviderActivatedPayload> {
  return createDomainEvent({ type: ProviderEventType.ProviderActivated, aggregateType: 'HealthcareProvider', aggregateId: payload.providerId, payload });
}

export function providerSuspendedEvent(payload: ProviderSuspendedPayload): DomainEvent<ProviderSuspendedPayload> {
  return createDomainEvent({ type: ProviderEventType.ProviderSuspended, aggregateType: 'HealthcareProvider', aggregateId: payload.providerId, payload });
}

export interface ProviderProfileChangedPayload {
  providerId: string;
  /** The audit action of the change, e.g. `PROVIDER_LOCATION_ADDED`. */
  change: string;
}

export function providerProfileChangedEvent(payload: ProviderProfileChangedPayload): DomainEvent<ProviderProfileChangedPayload> {
  return createDomainEvent({ type: ProviderEventType.ProviderProfileChanged, aggregateType: 'HealthcareProvider', aggregateId: payload.providerId, payload });
}
