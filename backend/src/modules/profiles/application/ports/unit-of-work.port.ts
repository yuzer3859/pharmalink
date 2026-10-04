export const UNIT_OF_WORK = Symbol('PROFILES_UNIT_OF_WORK');

/**
 * Transaction boundary port (mirrors `modules/identity/application/ports/unit-of-work.port.ts`
 * — kept as a local copy per module-02 §2, "no new dependency on Identity's internals"). `tx`
 * is an opaque handle passed straight through to repository methods.
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
