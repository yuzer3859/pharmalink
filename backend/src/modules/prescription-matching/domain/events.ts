import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';
import { ChosenResult } from './repositories/match.repository';

/**
 * Prescription & Matching domain event types (module-05 §9) — the inter-module contract,
 * matching `architecture/00-domain-event-catalog.md`'s Module 05 row exactly (no additions or
 * omissions beyond what's already contracted). Written to the outbox in the same transaction as
 * the triggering state change (ADR-010), mirroring `modules/catalog/domain/events.ts`.
 */
export const PrescriptionMatchingEventType = {
  PrescriptionUploaded: 'prescription.uploaded',
  PrescriptionApproved: 'prescription.approved',
  PrescriptionRejected: 'prescription.rejected',
  MedicineDispensed: 'prescription.medicine_dispensed',
  OrderMatched: 'matching.order_matched',
  RematchTriggered: 'matching.rematch_triggered',
  MatchFailed: 'matching.match_failed',
} as const;

export interface PrescriptionUploadedPayload {
  prescriptionId: string;
  customerUserId: string;
}

export interface PrescriptionApprovedLine {
  lineId: string;
  catalogProductId: string;
  approvedQuantity: number;
}

export interface PrescriptionApprovedPayload {
  prescriptionId: string;
  lines: PrescriptionApprovedLine[];
}

export interface PrescriptionRejectedPayload {
  prescriptionId: string;
  reason: string;
}

export interface MedicineDispensedPayload {
  prescriptionLineId: string;
  orderId: string;
  quantity: number;
}

/** `orderId` is `null`/absent until Module 06 exists and actually creates an order (§9 note). */
export interface OrderMatchedPayload {
  matchRequestId: string;
  orderId: string | null;
  result: ChosenResult | null;
}

export interface RematchTriggeredPayload {
  matchRequestId: string;
  excludedPharmacyId: string;
}

export interface MatchFailedPayload {
  matchRequestId: string;
}

export function prescriptionUploadedEvent(
  payload: PrescriptionUploadedPayload,
): DomainEvent<PrescriptionUploadedPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.PrescriptionUploaded,
    aggregateType: 'Prescription',
    aggregateId: payload.prescriptionId,
    payload,
  });
}

export function prescriptionApprovedEvent(
  payload: PrescriptionApprovedPayload,
): DomainEvent<PrescriptionApprovedPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.PrescriptionApproved,
    aggregateType: 'Prescription',
    aggregateId: payload.prescriptionId,
    payload,
  });
}

export function prescriptionRejectedEvent(
  payload: PrescriptionRejectedPayload,
): DomainEvent<PrescriptionRejectedPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.PrescriptionRejected,
    aggregateType: 'Prescription',
    aggregateId: payload.prescriptionId,
    payload,
  });
}

export function medicineDispensedEvent(
  payload: MedicineDispensedPayload,
): DomainEvent<MedicineDispensedPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.MedicineDispensed,
    aggregateType: 'PrescriptionLine',
    aggregateId: payload.prescriptionLineId,
    payload,
  });
}

export function orderMatchedEvent(payload: OrderMatchedPayload): DomainEvent<OrderMatchedPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.OrderMatched,
    aggregateType: 'MatchRequest',
    aggregateId: payload.matchRequestId,
    payload,
  });
}

export function rematchTriggeredEvent(
  payload: RematchTriggeredPayload,
): DomainEvent<RematchTriggeredPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.RematchTriggered,
    aggregateType: 'MatchRequest',
    aggregateId: payload.matchRequestId,
    payload,
  });
}

export function matchFailedEvent(payload: MatchFailedPayload): DomainEvent<MatchFailedPayload> {
  return createDomainEvent({
    type: PrescriptionMatchingEventType.MatchFailed,
    aggregateType: 'MatchRequest',
    aggregateId: payload.matchRequestId,
    payload,
  });
}
