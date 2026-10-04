export const UNIT_OF_WORK = Symbol('PAYMENT_UNIT_OF_WORK');

/**
 * Transaction boundary port (own copy per ADR-002, mirroring
 * `modules/orders/application/ports/unit-of-work.port.ts` and its Module 03/04/05 siblings —
 * never a cross-module import). `tx` is an opaque handle passed straight through to
 * `IPaymentRepository`/`ILedgerRepository` methods and to `LedgerService.post`.
 *
 * Money commands are the reason this exists: a capture must commit its `Payment` state change,
 * its double-entry postings, its audit entry and its outbox event together or not at all
 * (ADR-010, ADR-013, §11.3). Nothing in this ledger/payment-foundation task opens a transaction
 * through it yet — the payment-command task does — but the port and its `Serializable`
 * implementation are established here alongside the repositories they wrap, exactly as Module
 * 06's own foundation task did.
 *
 * `LedgerService.post()` also works without a caller-supplied `tx`: `PrismaLedgerRepository`
 * guarantees a posting is atomic on its own (see `ILedgerRepository.createTransaction`). This
 * port is for the *wider* boundary — several repositories plus audit plus outbox — not for
 * making a single posting atomic.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
