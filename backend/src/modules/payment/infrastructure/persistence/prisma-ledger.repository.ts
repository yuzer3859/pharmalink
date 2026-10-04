import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AccountBalance as PrismaAccountBalance,
  LedgerAccount as PrismaLedgerAccount,
  LedgerDirection,
  LedgerEntry as PrismaLedgerEntry,
  LedgerTransaction as PrismaLedgerTransaction,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  LedgerAccountProps,
  LedgerEntryProps,
  LedgerTransactionDraft,
  LedgerTransactionProps,
  PostedLedgerTransaction,
} from '../../domain/entities/ledger-transaction.entity';
import {
  AccountBalanceSnapshot,
  AccountEntryPage,
  ILedgerRepository,
  LedgerEntryTotals,
} from '../../domain/repositories/ledger.repository';
import { AccountRefKey } from '../../domain/value-objects/account-ref.vo';

type Client = PrismaService | Prisma.TransactionClient;

function toAccountProps(row: PrismaLedgerAccount): LedgerAccountProps {
  return {
    id: row.id,
    type: row.type,
    ownerId: row.ownerId,
    currency: row.currency,
    createdAt: row.createdAt,
  };
}

function toTransactionProps(row: PrismaLedgerTransaction): LedgerTransactionProps {
  return {
    id: row.id,
    reference: row.reference,
    type: row.type,
    refType: row.refType,
    refId: row.refId,
    description: row.description,
    createdAt: row.createdAt,
  };
}

function toEntryProps(row: PrismaLedgerEntry): LedgerEntryProps {
  return {
    id: row.id,
    transactionId: row.transactionId,
    accountId: row.accountId,
    direction: row.direction,
    amount: row.amount,
    currency: row.currency,
    createdAt: row.createdAt,
  };
}

function toBalanceSnapshot(row: PrismaAccountBalance): AccountBalanceSnapshot {
  return {
    accountId: row.accountId,
    balance: row.balance,
    currency: row.currency,
    updatedAt: row.updatedAt,
  };
}

/**
 * Prisma adapter for `ILedgerRepository` (§7 `ledger_accounts` / `ledger_transactions` /
 * `ledger_entries` / `account_balances`).
 *
 * **Immutability.** This class exposes no update and no delete path for `ledger_transactions` or
 * `ledger_entries` — there is no method to call, and no Prisma `update`/`delete` against either
 * table anywhere in it. The database backs that up: the
 * `ledger_transactions_append_only`/`ledger_entries_append_only` triggers
 * (`20260908000000_module07_payment_ledger_foundation`) reject any `UPDATE`/`DELETE`, including
 * from raw SQL (ADR-006, §13). The only row this adapter ever *updates* is the derived
 * `account_balances` cache, which the design explicitly describes as rebuildable (§7, §14).
 *
 * **Transactions.** Unlike the Module 04/05/06 adapters, `createTransaction` opens its own
 * `Serializable` transaction when the caller does not supply one. That deviation is deliberate
 * and narrow: a posting spans a header row, N entry rows and the balance-cache refresh, and a
 * half-written posting would be an unbalanced ledger that can never be repaired (ledger rows are
 * append-only by construction). Every other method is an ordinary statement against the
 * caller-supplied client, exactly like the other adapters.
 */
@Injectable()
export class PrismaLedgerRepository implements ILedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findAccountById(id: string, tx?: unknown): Promise<LedgerAccountProps | null> {
    const row = await this.client(tx).ledgerAccount.findUnique({ where: { id } });
    return row ? toAccountProps(row) : null;
  }

  /**
   * Resolves by the natural key. Deliberately a `findFirst`, not a `findUnique` on the composite
   * key: `ownerId` is NULL for platform-level accounts, and Prisma's compound-unique `where`
   * input cannot express NULL (Postgres treats NULLs as distinct in a unique index, so the
   * composite index does not identify those rows). Uniqueness for owner-scoped accounts comes
   * from `ledger_accounts_type_ownerId_currency_key` and for platform accounts from the partial
   * `ledger_accounts_platform_type_currency_key` index added alongside this module — so this
   * lookup still matches at most one row.
   */
  async findAccountByRef(ref: AccountRefKey, tx?: unknown): Promise<LedgerAccountProps | null> {
    const row = await this.client(tx).ledgerAccount.findFirst({
      where: { type: ref.type, ownerId: ref.ownerId, currency: ref.currency },
    });
    return row ? toAccountProps(row) : null;
  }

  async createAccount(ref: AccountRefKey, tx?: unknown): Promise<LedgerAccountProps> {
    const row = await this.client(tx).ledgerAccount.create({
      data: { type: ref.type, ownerId: ref.ownerId, currency: ref.currency },
    });
    return toAccountProps(row);
  }

  /**
   * Concurrency-safe open-on-first-use. Two requests can race to open the same account; the
   * unique index (composite for owner-scoped accounts, the partial
   * `ledger_accounts_platform_type_currency_key` for platform accounts) picks a winner and the
   * loser re-reads it (`P2002`), mirroring `ReserveStockCommand`'s idempotency-race handling.
   * The alternative — surfacing the unique violation — would fail a legitimate money operation
   * for a benign race.
   */
  async findOrCreateAccount(ref: AccountRefKey, tx?: unknown): Promise<LedgerAccountProps> {
    const existing = await this.findAccountByRef(ref, tx);
    if (existing) {
      return existing;
    }
    try {
      return await this.createAccount(ref, tx);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        !tx
      ) {
        const winner = await this.findAccountByRef(ref, tx);
        if (winner) {
          return winner;
        }
      }
      // Inside a caller-supplied transaction the conflicting insert is not yet visible and the
      // transaction is already aborted, so re-reading here would be meaningless — the caller's
      // retry (ADR-013) is what resolves that case.
      throw error;
    }
  }

  async createTransaction(
    draft: LedgerTransactionDraft,
    tx?: unknown,
  ): Promise<PostedLedgerTransaction> {
    // Entry ids are generated here rather than by the database default so the committed entries
    // can be returned in the exact order the caller drafted them (a nested create's result order
    // is not specified, and `createdAt` ties within a single statement).
    const entries = draft.entries.map((entry) => ({
      id: randomUUID(),
      accountId: entry.accountId,
      direction: entry.direction,
      amount: entry.amount.amountMinor,
      currency: entry.amount.currency.code,
    }));

    const write = async (client: Client): Promise<PostedLedgerTransaction> => {
      const row = await client.ledgerTransaction.create({
        data: {
          reference: draft.reference,
          type: draft.type,
          refType: draft.refType,
          refId: draft.refId,
          description: draft.description,
          entries: { create: entries },
        },
        include: { entries: true },
      });

      await this.refreshCachedBalances(client, draft.affectedAccountIds());

      const byId = new Map(row.entries.map((entry) => [entry.id, entry]));
      return {
        transaction: toTransactionProps(row),
        entries: entries.map((entry) => toEntryProps(byId.get(entry.id) as PrismaLedgerEntry)),
      };
    };

    if (tx) {
      return write(tx as Prisma.TransactionClient);
    }
    return this.prisma.$transaction((ownTx) => write(ownTx), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  async findTransactionById(id: string, tx?: unknown): Promise<PostedLedgerTransaction | null> {
    const row = await this.client(tx).ledgerTransaction.findUnique({
      where: { id },
      include: { entries: { orderBy: { id: 'asc' } } },
    });
    return row
      ? { transaction: toTransactionProps(row), entries: row.entries.map(toEntryProps) }
      : null;
  }

  async findTransactionByReference(
    reference: string,
    tx?: unknown,
  ): Promise<LedgerTransactionProps | null> {
    const row = await this.client(tx).ledgerTransaction.findUnique({ where: { reference } });
    return row ? toTransactionProps(row) : null;
  }

  async findEntriesByTransactionId(
    transactionId: string,
    tx?: unknown,
  ): Promise<LedgerEntryProps[]> {
    const rows = await this.client(tx).ledgerEntry.findMany({
      where: { transactionId },
      orderBy: { id: 'asc' },
    });
    return rows.map(toEntryProps);
  }

  async findEntriesByAccountId(accountId: string, tx?: unknown): Promise<LedgerEntryProps[]> {
    const rows = await this.client(tx).ledgerEntry.findMany({
      where: { accountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEntryProps);
  }

  /**
   * One account's entries inside `[from, to)` — the settlement read.
   *
   * `gte`/`lt`, never `lte`: an inclusive upper bound would put a posting written exactly on a
   * period boundary into two consecutive statements, and a provider would be paid for it twice.
   * Backed by `ledger_entries_accountId_createdAt_idx`.
   */
  async findEntriesByAccountInPeriod(
    accountId: string,
    period: { from: Date; to: Date },
    tx?: unknown,
  ): Promise<LedgerEntryProps[]> {
    const rows = await this.client(tx).ledgerEntry.findMany({
      where: { accountId, createdAt: { gte: period.from, lt: period.to } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEntryProps);
  }

  /**
   * Debit/credit totals per currency over every entry in the ledger — reconciliation's
   * global-imbalance check. Aggregated in the database rather than by loading entries, because
   * this question is asked of the whole table.
   */
  async sumAllEntriesByCurrency(tx?: unknown): Promise<LedgerEntryTotals[]> {
    const grouped = await this.client(tx).ledgerEntry.groupBy({
      by: ['currency', 'direction'],
      _sum: { amount: true },
    });

    const byCurrency = new Map<string, LedgerEntryTotals>();
    for (const group of grouped) {
      const totals = byCurrency.get(group.currency) ?? {
        debit: 0,
        credit: 0,
        currency: group.currency,
      };
      if (group.direction === LedgerDirection.DEBIT) {
        totals.debit += group._sum.amount ?? 0;
      } else {
        totals.credit += group._sum.amount ?? 0;
      }
      byCurrency.set(group.currency, totals);
    }
    return [...byCurrency.values()];
  }

  /**
   * A page of one account's entries with their headers, newest first (§9.4's wallet history).
   *
   * The `include` is the join: one query, not one per row. `count` runs alongside it rather than
   * after, so a posting landing between the two cannot make the page and the total disagree by
   * more than one page boundary — which is a pager artifact, not a financial statement. The
   * balance never comes from here; it comes from `sumEntriesByAccount`.
   */
  async listEntriesByAccountId(
    accountId: string,
    page: { skip: number; take: number },
    tx?: unknown,
  ): Promise<AccountEntryPage> {
    const client = this.client(tx);
    const [rows, total] = await Promise.all([
      client.ledgerEntry.findMany({
        where: { accountId },
        include: { transaction: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page.skip,
        take: page.take,
      }),
      client.ledgerEntry.count({ where: { accountId } }),
    ]);

    return {
      items: rows.map((row) => ({
        entry: toEntryProps(row),
        transaction: toTransactionProps(row.transaction),
      })),
      total,
    };
  }

  /** The authoritative balance input: aggregated straight off `ledger_entries` (§5.3). */
  async sumEntriesByAccount(accountId: string, tx?: unknown): Promise<LedgerEntryTotals> {
    const client = this.client(tx);
    const [account, grouped] = await Promise.all([
      client.ledgerAccount.findUnique({ where: { id: accountId }, select: { currency: true } }),
      client.ledgerEntry.groupBy({
        by: ['direction'],
        where: { accountId },
        _sum: { amount: true },
      }),
    ]);
    const totalFor = (direction: LedgerDirection): number =>
      grouped.find((group) => group.direction === direction)?._sum.amount ?? 0;

    return {
      debit: totalFor(LedgerDirection.DEBIT),
      credit: totalFor(LedgerDirection.CREDIT),
      currency: account?.currency ?? 'ETB',
    };
  }

  async findCachedBalance(
    accountId: string,
    tx?: unknown,
  ): Promise<AccountBalanceSnapshot | null> {
    const row = await this.client(tx).accountBalance.findUnique({ where: { accountId } });
    return row ? toBalanceSnapshot(row) : null;
  }

  /**
   * Refreshes the derived `account_balances` rows for the accounts a posting touched, inside the
   * same transaction as the entries themselves (§7 — "materialized balance cache (derived;
   * refreshed on posting)").
   *
   * It **recomputes** each balance from `ledger_entries` rather than incrementing the stored
   * value: an increment can only ever drift away from the ledger, while a recompute makes the
   * cache self-healing and keeps the ledger unambiguously the source of truth (ADR-006, §5.3).
   * `LedgerService.balanceOf()` still reads the entries, never this cache.
   */
  private async refreshCachedBalances(client: Client, accountIds: string[]): Promise<void> {
    for (const accountId of accountIds) {
      const totals = await this.sumEntriesByAccount(accountId, client);
      const balance = totals.credit - totals.debit;
      await client.accountBalance.upsert({
        where: { accountId },
        create: { accountId, balance, currency: totals.currency },
        update: { balance, currency: totals.currency },
      });
    }
  }
}
