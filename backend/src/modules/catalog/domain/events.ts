import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Catalog domain event types — the inter-module contract (module-03 §9). No current consumers
 * exist yet (Modules 04/05/14 aren't built), but these are emitted now so those modules can
 * subscribe later without a Module 03 change ("contracts first", roadmap §1). Written to the
 * outbox in the same transaction as the state change (ADR-010), from day one — unlike Module 02,
 * which retrofitted this after DEFECT-PROFILES-001/002 (see 02-profiles-spec.md §0).
 */
export const CatalogEventType = {
  ProductCreated: 'catalog.product.created',
  ProductUpdated: 'catalog.product.updated',
  ProductClassificationChanged: 'catalog.product.classification_changed',
  ProductStatusChanged: 'catalog.product.status_changed',
  CategoryCreated: 'catalog.category.created',
  CategoryUpdated: 'catalog.category.updated',
} as const;

export interface ProductCreatedPayload {
  productId: string;
  type: string;
  rxClassification: string | null;
  controlledSchedule: string;
}

export interface ProductUpdatedPayload {
  productId: string;
  fields: string[];
}

export interface ProductClassificationChangedPayload {
  productId: string;
  from: { rxClassification: string | null; controlledSchedule: string };
  to: { rxClassification: string | null; controlledSchedule: string };
}

export interface ProductStatusChangedPayload {
  productId: string;
  from: string;
  to: string;
  reason: string | null;
}

export interface CategoryCreatedPayload {
  categoryId: string;
  slug: string;
}

export interface CategoryUpdatedPayload {
  categoryId: string;
  fields: string[];
}

export function productCreatedEvent(
  payload: ProductCreatedPayload,
): DomainEvent<ProductCreatedPayload> {
  return createDomainEvent({
    type: CatalogEventType.ProductCreated,
    aggregateType: 'Product',
    aggregateId: payload.productId,
    payload,
  });
}

export function productUpdatedEvent(
  payload: ProductUpdatedPayload,
): DomainEvent<ProductUpdatedPayload> {
  return createDomainEvent({
    type: CatalogEventType.ProductUpdated,
    aggregateType: 'Product',
    aggregateId: payload.productId,
    payload,
  });
}

export function productClassificationChangedEvent(
  payload: ProductClassificationChangedPayload,
): DomainEvent<ProductClassificationChangedPayload> {
  return createDomainEvent({
    type: CatalogEventType.ProductClassificationChanged,
    aggregateType: 'Product',
    aggregateId: payload.productId,
    payload,
  });
}

export function productStatusChangedEvent(
  payload: ProductStatusChangedPayload,
): DomainEvent<ProductStatusChangedPayload> {
  return createDomainEvent({
    type: CatalogEventType.ProductStatusChanged,
    aggregateType: 'Product',
    aggregateId: payload.productId,
    payload,
  });
}

export function categoryCreatedEvent(
  payload: CategoryCreatedPayload,
): DomainEvent<CategoryCreatedPayload> {
  return createDomainEvent({
    type: CatalogEventType.CategoryCreated,
    aggregateType: 'Category',
    aggregateId: payload.categoryId,
    payload,
  });
}

export function categoryUpdatedEvent(
  payload: CategoryUpdatedPayload,
): DomainEvent<CategoryUpdatedPayload> {
  return createDomainEvent({
    type: CatalogEventType.CategoryUpdated,
    aggregateType: 'Category',
    aggregateId: payload.categoryId,
    payload,
  });
}
