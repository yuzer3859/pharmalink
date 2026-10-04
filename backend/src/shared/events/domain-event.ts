import { randomUUID } from 'crypto';

/**
 * A domain event — the inter-module contract (see architecture/00-domain-event-catalog.md).
 * `type` is the canonical dotted name, e.g. "order.placed". Payloads must be serializable
 * (they are persisted verbatim to the outbox).
 */
export interface DomainEvent<TPayload = unknown> {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  occurredAt: string;
}

export function createDomainEvent<TPayload>(params: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
}): DomainEvent<TPayload> {
  return {
    id: randomUUID(),
    type: params.type,
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    payload: params.payload,
    occurredAt: new Date().toISOString(),
  };
}

export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
) => void | Promise<void>;
