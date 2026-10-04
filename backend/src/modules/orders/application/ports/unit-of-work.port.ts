export const UNIT_OF_WORK = Symbol('ORDERS_UNIT_OF_WORK');

/**
 * Transaction boundary port (mirrors `modules/prescription-matching/application/ports/unit-of-
 * work.port.ts` / `modules/catalog/.../unit-of-work.port.ts` / `modules/profiles/.../unit-of-
 * work.port.ts` — kept as a local copy per ADR-002's "own copy per module" discipline, not a
 * cross-module import). `tx` is an opaque handle passed straight through to
 * `ICartRepository`/`IOrderRepository`/`IFulfillmentRepository` methods, letting the future
 * `CheckoutCommand`/fulfillment commands compose multiple repository calls inside one
 * `Serializable` transaction (module-06 `06-orders-spec.md` §4/§11, ADR-013) without any single
 * repository knowing about that orchestration.
 *
 * This module's own bounded-retry wrapper (`runWithOrderRetry`/`isRetryableTransactionConflict`,
 * §11, not built by this task) wraps calls to `run()` the same way module-05's
 * `runWithMatchRetry` wraps its own `IUnitOfWork.run()` calls — own copy, per ADR-002, not a
 * cross-module import of `match-retry.ts` (§11's explicit instruction).
 *
 * Cross-module port calls (Module 04's `IInventoryPort`, Module 05's `IMatchingPort`/
 * `ICheckRxGatePort`/`IDispensingPort`) each open their own, separate transaction — this
 * interface makes no attempt to span those into a single distributed transaction (ADR-014's
 * accepted eventual-consistency seam); it only bounds *this* module's own multi-repository writes.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
