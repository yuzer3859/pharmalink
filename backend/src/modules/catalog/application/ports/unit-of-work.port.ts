export const UNIT_OF_WORK = Symbol('CATALOG_UNIT_OF_WORK');

/**
 * Transaction boundary port (mirrors `modules/profiles/application/ports/unit-of-work.port.ts`
 * — kept as a local copy per module-03 §2, "no new dependency on another module's internals").
 * `tx` is an opaque handle passed straight through to repository methods.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
