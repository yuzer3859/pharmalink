import {
  LedgerAccountProps,
  LedgerEntryProps,
  LedgerTransactionDraft,
  LedgerTransactionProps,
  PostedLedgerTransaction,
} from '../entities/ledger-transaction.entity';
import { AccountRefKey } from '../value-objects/account-ref.vo';

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

/** Raw debit/credit totals for one account, in minor units — the input to a derived balance. */
export interface LedgerEntryTotals {
  debit: number;
  credit: number;
  currency: string;
}

/**
 * The materialized `account_balances` row (§7). Explicitly a **cache**: it is refreshed from the
 * entries inside the same transaction that writes them, and is rebuildable from
 * `ledger_entries` at any time. Nothing in this module treats it as authoritative — every
 * balance a caller acts on comes from `sumEntriesByAccount` (see `ILedgerRepository` below).
 */
export interface AccountBalanceSnapshot {
  accountId: string;
  balance: number;
  currency: string;
  updatedAt: Date;
}

/**
 * One of an account's entries together with the transaction it belongs to — the shape a wallet
 * history row is built from (§9.4 "GET /wallet/transactions - history").
 *
 * The join lives in the repository rather than in the query because the alternative is an N+1:
 * read the entries, then fetch each entry's header one at a time. Only the account's *own* entries
 * are returned, never the counterpart legs, so a customer's history cannot expose which platform
 * or provider account the other side of a movement touched.
 */
export interface AccountEntryWithTransaction {
  entry: LedgerEntryProps;
  transaction: LedgerTransactionProps;
}

/** A page of an account's entries, newest first, plus the total for the caller's pager. */
export interface AccountEntryPage {
  items: AccountEntryWithTransaction[];
  total: number;
}

/**
 * Persistence port for the double-entry ledger (§5.1, §7). Domain/application-facing snapshots
 * only — no Prisma type crosses this boundary, per ADR-002 and every Module 04/05/06 repository.
 *
 * **This interface has no update and no delete method, and never will.** That absence *is* the
 * append-only guarantee at the application layer (ADR-006, §5.3 "a posting that doesn't balance
 * is rejected"; §13 "the ledger is the financial audit trail (immutable)"). It is backed at the
 * database layer by the `ledger_transactions_append_only` / `ledger_entries_append_only`
 * triggers added in `20260908000000_module07_payment_ledger_foundation`, so even raw SQL cannot
 * rewrite history.
 *
 * Every method takes an optional `tx` handle, following the convention of every other repository
 * in the codebase, so a future money command can compose ledger writes with its own aggregate
 * writes, its audit entry and its outbox event inside one `Serializable` transaction (ADR-010,
 * ADR-013). `createTransaction` is the one deliberate deviation from "the adapter never opens
 * its own transaction" — see its doc comment.
 */
export interface ILedgerRepository {
  findAccountById(id: string, tx?: unknown): Promise<LedgerAccountProps | null>;
  /** Resolves an account by its natural key `(type, ownerId, currency)` (§7's unique index). */
  findAccountByRef(ref: AccountRefKey, tx?: unknown): Promise<LedgerAccountProps | null>;
  createAccount(ref: AccountRefKey, tx?: unknown): Promise<LedgerAccountProps>;
  /**
   * Opens the account if it does not exist yet, otherwise returns the existing one. Concurrency
   * safe: a lost race against the `(type, ownerId, currency)` unique index is resolved by
   * re-reading, never by surfacing the unique violation.
   */
  findOrCreateAccount(ref: AccountRefKey, tx?: unknown): Promise<LedgerAccountProps>;

  /**
   * Persists one already-validated, balanced posting: the `ledger_transactions` header and all
   * of its `ledger_entries`, **atomically**, plus the derived `account_balances` refresh for
   * every account it touches.
   *
   * Atomicity is part of this contract, not the caller's problem: a partially written posting
   * (a header with no entries, or entries covering only one side) would be an unbalanced,
   * uncorrectable ledger, and ledger rows can never be repaired after the fact. When a `tx` is
   * supplied the caller's transaction provides it; when one is not, the adapter opens its own
   * `Serializable` transaction. Either way, a failure leaves zero rows behind.
   *
   * Rejects a duplicate `reference` (the database's unique index, BRULE-25) — the caller decides
   * whether that means "replay, return the original" or "defect".
   */
  createTransaction(
    draft: LedgerTransactionDraft,
    tx?: unknown,
  ): Promise<PostedLedgerTransaction>;

  findTransactionById(id: string, tx?: unknown): Promise<PostedLedgerTransaction | null>;
  /** Idempotency/reconciliation lookup by the unique business reference (BRULE-25). */
  findTransactionByReference(
    reference: string,
    tx?: unknown,
  ): Promise<LedgerTransactionProps | null>;

  findEntriesByTransactionId(transactionId: string, tx?: unknown): Promise<LedgerEntryProps[]>;
  findEntriesByAccountId(accountId: string, tx?: unknown): Promise<LedgerEntryProps[]>;

  /**
   * A page of one account's entries with their transaction headers, newest first. Added by the
   * wallet task for §9.4's history; a plain `findEntriesByAccountId` would load a customer's
   * entire ledger history into memory to show them twenty rows.
   *
   * Ordering is `(createdAt DESC, id DESC)` — the id breaks ties so two entries written in the
   * same posting, which share a timestamp, keep a stable order across pages.
   */
  listEntriesByAccountId(
    accountId: string,
    page: { skip: number; take: number },
    tx?: unknown,
  ): Promise<AccountEntryPage>;

  /**
   * One account's entries whose posting fell inside `[from, to)`, oldest first.
   *
   * Added for settlement: a statement covers a period, and `findEntriesByAccountId` would load a
   * provider's entire history to report one month of it. The window is **half-open** for the same
   * reason `SettlementPeriod` is — an inclusive end would let a posting written exactly on the
   * boundary appear in two consecutive statements and be paid twice.
   *
   * Read-only, like every other method here; it opens no transaction and writes nothing.
   */
  findEntriesByAccountInPeriod(
    accountId: string,
    period: { from: Date; to: Date },
    tx?: unknown,
  ): Promise<LedgerEntryProps[]>;

  /**
   * Debit/credit totals per currency across **every** entry in the ledger.
   *
   * Exists only for reconciliation's global-imbalance check (§3.6 F-REC-01). It is the one
   * question that cannot be asked of a single account: an individual posting can balance while the
   * ledger as a whole does not, if rows were ever written outside `createTransaction`.
   */
  sumAllEntriesByCurrency(tx?: unknown): Promise<LedgerEntryTotals[]>;

  /**
   * Debit/credit totals for one account, aggregated over `ledger_entries`. This is the
   * authoritative input to a balance (§5.3: "a balance is never stored as an authoritative
   * mutable field — it's Σ credits − Σ debits over an account's entries").
   */
  sumEntriesByAccount(accountId: string, tx?: unknown): Promise<LedgerEntryTotals>;

  /**
   * Reads the materialized cache row. Provided for reconciliation and for the future
   * high-volume wallet read path — never as a substitute for `sumEntriesByAccount` when a
   * decision about money depends on the answer.
   */
  findCachedBalance(accountId: string, tx?: unknown): Promise<AccountBalanceSnapshot | null>;
}
