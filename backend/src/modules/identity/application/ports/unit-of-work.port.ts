export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/**
 * Transaction boundary port. `tx` is an opaque handle passed straight through to repository
 * methods (which accept it as `unknown` and cast internally in the Prisma adapter) — this lets
 * use cases compose atomic writes (e.g. create user + write outbox event) without the
 * application layer depending on Prisma (Dependency Rule, module-01 §12).
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
