import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Pharmacy & Inventory domain event types — the inter-module contract (module-04 §9), written
 * to the outbox in the same transaction as the state change (ADR-010), same convention as
 * Module 03's `domain/events.ts`.
 */
export const PharmacyInventoryEventType = {
  PharmacyActivated: 'pharmacy.pharmacy.activated',
  PharmacySuspended: 'pharmacy.pharmacy.suspended',
  ListingCreated: 'pharmacy.listing.created',
  ListingDisabled: 'pharmacy.listing.disabled',
  PriceChanged: 'pharmacy.listing.price_changed',
  StockReceived: 'pharmacy.stock.received',
  StockReserved: 'pharmacy.stock.reserved',
  StockReleased: 'pharmacy.stock.released',
  StockDispatched: 'pharmacy.stock.dispatched',
} as const;

export interface PharmacyActivatedPayload {
  pharmacyId: string;
  organizationId: string;
}

export interface PharmacySuspendedPayload {
  pharmacyId: string;
  reason: 'LICENSE_EXPIRED' | 'MANUAL';
}

export interface ListingCreatedPayload {
  listingId: string;
  catalogProductId: string;
  branchId: string;
  pharmacyId: string;
  price: number;
}

export interface ListingDisabledPayload {
  listingId: string;
}

export interface PriceChangedPayload {
  listingId: string;
  oldPrice: number;
  newPrice: number;
}

export interface StockReceivedPayload {
  listingId: string;
  batchId: string;
  quantity: number;
  expiryDate: string;
}

export interface StockReservedPayload {
  listingId: string;
  reservationId: string;
  orderId: string | null;
  quantity: number;
}

export interface StockReleasedPayload {
  listingId: string;
  reservationId: string;
  quantity: number;
  reason: string | null;
}

export interface StockDispatchedPayload {
  listingId: string;
  orderId: string | null;
  quantity: number;
  batchAllocations: Array<{ batchId: string; qty: number }>;
}

export function pharmacyActivatedEvent(
  payload: PharmacyActivatedPayload,
): DomainEvent<PharmacyActivatedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.PharmacyActivated,
    aggregateType: 'Pharmacy',
    aggregateId: payload.pharmacyId,
    payload,
  });
}

export function pharmacySuspendedEvent(
  payload: PharmacySuspendedPayload,
): DomainEvent<PharmacySuspendedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.PharmacySuspended,
    aggregateType: 'Pharmacy',
    aggregateId: payload.pharmacyId,
    payload,
  });
}

export function listingCreatedEvent(
  payload: ListingCreatedPayload,
): DomainEvent<ListingCreatedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.ListingCreated,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}

export function listingDisabledEvent(
  payload: ListingDisabledPayload,
): DomainEvent<ListingDisabledPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.ListingDisabled,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}

export function priceChangedEvent(
  payload: PriceChangedPayload,
): DomainEvent<PriceChangedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.PriceChanged,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}

export function stockReceivedEvent(
  payload: StockReceivedPayload,
): DomainEvent<StockReceivedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.StockReceived,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}

export function stockReservedEvent(
  payload: StockReservedPayload,
): DomainEvent<StockReservedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.StockReserved,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}

export function stockReleasedEvent(
  payload: StockReleasedPayload,
): DomainEvent<StockReleasedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.StockReleased,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}

export function stockDispatchedEvent(
  payload: StockDispatchedPayload,
): DomainEvent<StockDispatchedPayload> {
  return createDomainEvent({
    type: PharmacyInventoryEventType.StockDispatched,
    aggregateType: 'InventoryListing',
    aggregateId: payload.listingId,
    payload,
  });
}
