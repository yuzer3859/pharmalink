import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Cart, Checkout & Orders domain event types (module-06 `06-orders-spec.md` §8), matching
 * `00-domain-event-catalog.md`'s Module 06 row **restricted to the subset actually reachable in
 * Slice 1** — `OrderDispatched`/`OrderDelivered`/`OrderCompleted` are not defined here at all
 * (no trigger exists without Module 08, §0.2; mirrors module-05 §0.2's "no speculative event
 * with no cataloged consumer" discipline, applied here to "no reachable trigger" instead).
 * Written to the outbox in the same transaction as the triggering state change (ADR-010) — this
 * file defines the event *shapes* only; no `OutboxService`/application-layer wiring is part of
 * this domain-foundation task (§9/§14).
 */
export const OrdersEventType = {
  OrderPlaced: 'order.placed',
  OrderPaid: 'order.paid',
  OrderAccepted: 'order.accepted',
  OrderReady: 'order.ready',
  OrderCancelled: 'order.cancelled',
} as const;

export interface OrderPlacedPayload {
  orderId: string;
  customerUserId: string;
  totals: { grandTotal: number; currency: string };
}

/** `paymentId` is `null`/absent until Module 07 exists (§8's note) — every Slice-1 order is COD,
 * so this is always `null` today, the same documented nullability pattern module-05 §9 used for
 * `OrderMatched.orderId` pre-Module-06. */
export interface OrderPaidPayload {
  orderId: string;
  paymentId: string | null;
}

export interface OrderAcceptedPayload {
  orderId: string;
  fulfillmentId: string;
  pharmacyId: string;
}

export interface OrderReadyPayload {
  orderId: string;
  fulfillmentId: string;
}

export interface OrderCancelledPayload {
  orderId: string;
  reason: string;
}

export function orderPlacedEvent(payload: OrderPlacedPayload): DomainEvent<OrderPlacedPayload> {
  return createDomainEvent({
    type: OrdersEventType.OrderPlaced,
    aggregateType: 'Order',
    aggregateId: payload.orderId,
    payload,
  });
}

export function orderPaidEvent(payload: OrderPaidPayload): DomainEvent<OrderPaidPayload> {
  return createDomainEvent({
    type: OrdersEventType.OrderPaid,
    aggregateType: 'Order',
    aggregateId: payload.orderId,
    payload,
  });
}

export function orderAcceptedEvent(
  payload: OrderAcceptedPayload,
): DomainEvent<OrderAcceptedPayload> {
  return createDomainEvent({
    type: OrdersEventType.OrderAccepted,
    aggregateType: 'Order',
    aggregateId: payload.orderId,
    payload,
  });
}

export function orderReadyEvent(payload: OrderReadyPayload): DomainEvent<OrderReadyPayload> {
  return createDomainEvent({
    type: OrdersEventType.OrderReady,
    aggregateType: 'Order',
    aggregateId: payload.orderId,
    payload,
  });
}

export function orderCancelledEvent(
  payload: OrderCancelledPayload,
): DomainEvent<OrderCancelledPayload> {
  return createDomainEvent({
    type: OrdersEventType.OrderCancelled,
    aggregateType: 'Order',
    aggregateId: payload.orderId,
    payload,
  });
}
