export const UNIT_OF_WORK = Symbol('PRESCRIPTION_MATCHING_UNIT_OF_WORK');

/**
 * Transaction boundary port (mirrors `modules/catalog/application/ports/unit-of-work.port.ts` /
 * `modules/profiles/application/ports/unit-of-work.port.ts` — kept as a local copy per ADR-002's
 * "own copy per module" discipline, not a cross-module import). `tx` is an opaque handle passed
 * straight through to repository methods.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
