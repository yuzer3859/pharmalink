import { StockReservationProps } from '../entities/stock-reservation.entity';
import { ReservationStatus } from '../enums';

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

export interface NewReservationInput {
  id: string;
  listingId: string;
  orderId: string | null;
  quantity: number;
  expiresAt: Date;
  idempotencyKey: string;
}

/**
 * Lock ordering convention (module-04 §8, applies to all reservation-mutating flows —
 * release/confirm/dispatch/TTL-sweep — that must lock both a reservation row and its listing
 * row in the same transaction): **always lock the reservation row first, then the listing
 * row.** `ReservationTtlSweeper` already locks its batch of reservation rows first (`SELECT ...
 * FOR UPDATE SKIP LOCKED` in `lockExpiredHeldBatch`, since it doesn't know which listings are
 * involved until it has found the expired reservations) and only then locks each affected
 * listing — `ReleaseReservationCommand`, `ConfirmReservationCommand` and `DispatchStockCommand`
 * follow the same order (`lockForUpdate` the reservation via its known `reservationId`, re-read
 * its status under that lock, then lock the listing it points to) so no two of these flows ever
 * acquire the two locks in opposite order. `ReserveStockCommand` only ever locks the listing (no
 * reservation row exists yet at that point), so it never participates in this ordering conflict.
 */
export interface IReservationRepository {
  findById(id: string, tx?: unknown): Promise<StockReservationProps | null>;
  /**
   * `SELECT ... FOR UPDATE` on a single reservation row (module-04 §8) — used by
   * release/confirm/dispatch to re-validate `status` under lock, INSIDE the transaction, instead
   * of trusting a pre-transaction `findById` read (which is racy: two concurrent transitions can
   * both pass a pre-check taken before either acquires a lock). Requires the interactive
   * transaction client, never the bare `PrismaService`.
   */
  lockForUpdate(id: string, tx: unknown): Promise<StockReservationProps | null>;
  /**
   * Idempotency lookup (§5.4/§8/§15). `stock_reservations.idempotencyKey` is the persisted,
   * DB-unique-constrained (`(listingId, idempotencyKey)`) dedup key — the actual client-supplied
   * value, not a derived `(listingId, orderId)` proxy. Called INSIDE `ReserveStockCommand`'s
   * transaction, under the same listing row lock as the rest of reserve, so a race is resolved
   * by whichever transaction commits its insert first; the loser re-reads via this method after
   * catching the unique-violation (Prisma `P2002`).
   */
  findByIdempotencyKey(
    listingId: string,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<StockReservationProps | null>;
  create(reservation: NewReservationInput, tx?: unknown): Promise<void>;
  updateStatus(id: string, status: ReservationStatus, tx?: unknown): Promise<void>;
  /**
   * `SELECT ... WHERE status = 'HELD' AND expiresAt < $1 ORDER BY expiresAt ASC LIMIT 1 FOR
   * UPDATE SKIP LOCKED` (module-04 §8, hardening pass) — discovery and locking combined into a
   * single query, deliberately kept as the very FIRST statement of its own per-reservation
   * transaction (module-04 hardening: one transaction per reservation, not one shared batch
   * transaction — see `ReservationTtlSweeper`'s class doc comment). This mirrors the original
   * single-query `FOR UPDATE SKIP LOCKED` batch scan's race characteristics against a concurrent
   * manual confirm/release (both now reach their first row-lock attempt after the same number of
   * round trips) — a two-step "find unlocked candidate ids, then lock separately" design would
   * insert an extra network round trip before the lock is taken, widening the race window against
   * concurrent flows for no correctness benefit. `SKIP LOCKED` means a row currently held by a
   * concurrent manual release/confirm/dispatch is simply left for a later sweep tick rather than
   * blocking; `LIMIT 1` scoped to a single row is what makes per-reservation transactions
   * possible without re-introducing a shared multi-row lock. Returns `null` when there is no
   * more eligible (and currently unlocked) candidate — the sweeper's loop stops for this tick.
   * `excludeIds` lets the sweeper skip rows it already tried and failed to expire earlier in the
   * SAME tick (an invariant violation) — without it, a single permanently-invalid row would
   * always be the earliest `expiresAt` and would be re-selected by every subsequent iteration,
   * starving every other eligible reservation for the rest of the tick.
   */
  lockNextExpired(now: Date, excludeIds: string[], tx: unknown): Promise<StockReservationProps | null>;
  /**
   * Read-only join to `stock_movements` answering "has this reservation been dispatched"
   * (§8/§14.7, hardening pass). Scoped by `reservationId` alone (via `stock_movements
   * .reservationId`) — NOT by `orderId` — because a single order can hold more than one
   * reservation (same or different listings); scoping by `orderId` would incorrectly report a
   * sibling reservation's dispatch as this reservation's own. Must be called with the active
   * transaction client (`tx`) when invoked from inside `DispatchStockCommand`'s transaction, so
   * the already-dispatched check sees the same in-flight state as the rest of that transaction.
   */
  findDispatchMovements(
    reservationId: string,
    tx?: unknown,
  ): Promise<Array<{ batchId: string | null; qty: number }>>;
}
