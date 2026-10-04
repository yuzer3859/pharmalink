export const UNIT_OF_WORK = Symbol('PHARMACY_INVENTORY_UNIT_OF_WORK');

/**
 * Transaction boundary port (module-04 §12, mirroring Module 02/03's `IUnitOfWork`). Unlike
 * those modules, Module 04's mutation transactions run at `Read Committed` — correctness for
 * the reserve flow comes from the explicit `SELECT ... FOR UPDATE` row lock, not from
 * Serializable isolation (§8) — so no dedup/serialization retry wrapper is needed here.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
