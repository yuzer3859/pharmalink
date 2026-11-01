export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface UnitOfWorkOptions {
  /**
   * `serializable` runs the unit at Serializable isolation and retries it (a bounded number of
   * times) when a concurrent transaction makes it fail to serialize. Use it when the unit's
   * correctness depends on what it read (a one-time check, a uniqueness decision) or when it appends
   * to the hash-chained audit log inside the transaction (AuditService: the caller then owns the
   * no-fork guarantee). Default: the database's default isolation, no retry.
   */
  isolation?: 'serializable';
}

/**
 * Transaction boundary port. `tx` is an opaque handle passed straight through to repository
 * methods (which accept it as `unknown` and cast internally in the Prisma adapter) — this lets
 * use cases compose atomic writes (e.g. create user + write outbox event) without the
 * application layer depending on Prisma (Dependency Rule, module-01 §12).
 */
export interface IUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
