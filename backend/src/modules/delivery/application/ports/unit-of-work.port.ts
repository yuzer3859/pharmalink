export const UNIT_OF_WORK = Symbol('DELIVERY_UNIT_OF_WORK');

/**
 * Transaction boundary port (own copy per ADR-002, mirroring
 * `modules/orders/application/ports/unit-of-work.port.ts` and its Module 03/04/05/07 siblings —
 * never a cross-module import). `tx` is an opaque handle passed straight through to
 * `IDeliveryJobRepository` methods, to `AuditService.record` and to `OutboxService.write`.
 *
 * ADR-013 is why it exists here: creating a delivery job co-locates an insert, an audit entry and
 * an outbox event, and all three must commit together or not at all. A job that existed without
 * its `JobCreated` event would never be dispatched; an event without its job would dispatch a
 * driver to nothing.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
