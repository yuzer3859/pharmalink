export const ADMIN_UNIT_OF_WORK = Symbol('ADMIN_UNIT_OF_WORK');

/** One database transaction for Admin's own writes (Work 82's maker-checker, first). */
export interface IAdminUnitOfWork {
  run<T>(work: (tx: unknown) => Promise<T>): Promise<T>;
}
