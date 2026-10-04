import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Profiles domain event types — the inter-module contract (module-02 §9). No current consumers
 * exist yet (Orders/Delivery aren't built), but these are emitted now so those modules can
 * subscribe later without a Module 02 change ("contracts first", roadmap §1). Written to the
 * outbox in the same transaction as the state change, same as Module 01 (ADR-010).
 */
export const ProfilesEventType = {
  ProfileUpdated: 'profiles.profile.updated',
  AddressAdded: 'profiles.address.added',
  AddressUpdated: 'profiles.address.updated',
  AddressRemoved: 'profiles.address.removed',
  DefaultAddressChanged: 'profiles.address.default_changed',
} as const;

export interface ProfileUpdatedPayload {
  userId: string;
  profileId: string;
  fields: string[];
}

export interface AddressAddedPayload {
  userId: string;
  addressId: string;
  label: string;
  isDefault: boolean;
}

export interface AddressUpdatedPayload {
  userId: string;
  addressId: string;
  fields: string[];
}

export interface AddressRemovedPayload {
  userId: string;
  addressId: string;
  wasDefault: boolean;
}

export interface DefaultAddressChangedPayload {
  userId: string;
  addressId: string;
  previousAddressId: string | null;
}

export function profileUpdatedEvent(
  payload: ProfileUpdatedPayload,
): DomainEvent<ProfileUpdatedPayload> {
  return createDomainEvent({
    type: ProfilesEventType.ProfileUpdated,
    aggregateType: 'CustomerProfile',
    aggregateId: payload.profileId,
    payload,
  });
}

export function addressAddedEvent(
  payload: AddressAddedPayload,
): DomainEvent<AddressAddedPayload> {
  return createDomainEvent({
    type: ProfilesEventType.AddressAdded,
    aggregateType: 'Address',
    aggregateId: payload.addressId,
    payload,
  });
}

export function addressUpdatedEvent(
  payload: AddressUpdatedPayload,
): DomainEvent<AddressUpdatedPayload> {
  return createDomainEvent({
    type: ProfilesEventType.AddressUpdated,
    aggregateType: 'Address',
    aggregateId: payload.addressId,
    payload,
  });
}

export function addressRemovedEvent(
  payload: AddressRemovedPayload,
): DomainEvent<AddressRemovedPayload> {
  return createDomainEvent({
    type: ProfilesEventType.AddressRemoved,
    aggregateType: 'Address',
    aggregateId: payload.addressId,
    payload,
  });
}

export function defaultAddressChangedEvent(
  payload: DefaultAddressChangedPayload,
): DomainEvent<DefaultAddressChangedPayload> {
  return createDomainEvent({
    type: ProfilesEventType.DefaultAddressChanged,
    aggregateType: 'Address',
    aggregateId: payload.addressId,
    payload,
  });
}
