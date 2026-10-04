import { Inject, Injectable } from '@nestjs/common';
import {
  LedgerAccountProps,
  LedgerTransactionDraft,
  NewLedgerTransactionInput,
  PostedLedgerTransaction,
} from '../entities/ledger-transaction.entity';
import { PaymentErrors } from '../errors';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../repositories/ledger.repository';
import { AccountRef } from '../value-objects/account-ref.vo';
import { Currency } from '../value-objects/currency.vo';
import { Money } from '../value-objects/money.vo';

/**
 * **The only way money is posted.** (§5.3, §10 — "`LedgerService` is the guarded core — the only
 * way to post money, enforcing balanced double-entry".)
 *
 * Every money command in this module — capture, refund, wallet top-up/spend, settlement payout —
 * routes its postings through `post()`, so the double-entry invariants are enforced in exactly
 * one place rather than re-checked (or forgotten) per command. The service itself holds no
 * account semantics: it does not know what a capture debits or credits. That composition belongs
 * to the commands (§11.3–§11.6); this class guarantees only that whatever they compose is a
 * legal, balanced, single-currency, immutable posting.
 *
 * Dependencies are ports only (`ILedgerRepository`) — no Prisma, no HTTP, no gateway. Its
 * placement under `domain/services/` follows §10's folder layout.
 *
 * Deliberately absent: any method that edits or deletes a posted transaction or entry. Money
 * movements are corrected the way accounting corrects them — by posting a compensating
 * `ADJUSTMENT`/`REFUND` transaction — never by rewriting history (ADR-006, §13).
 */
@Injectable()
export class LedgerService {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
  ) {}

  /**
   * Validates and commits one double-entry posting.
   *
   * Validation happens first and entirely in memory (`LedgerTransactionDraft.create` — balance,
   * currency consistency, positive amounts, account and direction presence, reference), so an
   * illegal posting never reaches the database at all. Persistence is atomic across the header
   * and all of its entries (see `ILedgerRepository.createTransaction`): a failure leaves zero
   * ledger transactions and zero ledger entries behind.
   *
   * Pass `tx` to enlist the posting in a caller-owned `Serializable` transaction — the normal
   * case for a money command that must commit its aggregate state, its ledger postings, its
   * audit entry and its outbox event together (ADR-010/ADR-013).
   */
  async post(
    input: NewLedgerTransactionInput,
    tx?: unknown,
  ): Promise<PostedLedgerTransaction> {
    const draft = LedgerTransactionDraft.create(input);
    return this.ledger.createTransaction(draft, tx);
  }

  /**
   * Resolves the ledger account named by `ref`, opening it on first use. The chart of accounts
   * is keyed by `(type, ownerId, currency)` (§7), so "this customer's ETB wallet" is a stable
   * identity a command can name without carrying account UUIDs around.
   */
  async resolveAccount(ref: AccountRef, tx?: unknown): Promise<LedgerAccountProps> {
    return this.ledger.findOrCreateAccount(ref.toKey(), tx);
  }

  /**
   * The account's balance, **derived from its entries** as `Σ credits − Σ debits` (§5.3's sign
   * convention, verbatim). Never read from `account_balances`: that table is a rebuildable cache,
   * and a decision about money is made against the ledger itself.
   *
   * The result can legitimately be zero or negative, which is why `Money` in this module admits
   * both (see `money.vo.ts`).
   */
  async balanceOf(accountId: string, tx?: unknown): Promise<Money> {
    const totals = await this.ledger.sumEntriesByAccount(accountId, tx);
    const currency = Currency.of(totals.currency);
    return Money.of(totals.credit, currency).subtract(Money.of(totals.debit, currency));
  }

  /** Convenience wrapper: resolve the account for `ref`, then derive its balance. */
  async balanceOfAccount(ref: AccountRef, tx?: unknown): Promise<Money> {
    const account = await this.resolveAccount(ref, tx);
    return this.balanceOf(account.id, tx);
  }

  /**
   * Reads a committed posting back. Used by reconciliation (§3.6 F-REC-01) and by the
   * idempotent-replay path of a money command, which returns the *original* posting rather than
   * writing a second one (BRULE-25).
   */
  async findPosting(id: string, tx?: unknown): Promise<PostedLedgerTransaction> {
    const posted = await this.ledger.findTransactionById(id, tx);
    if (!posted) {
      throw PaymentErrors.notFound('Ledger transaction not found.', { id });
    }
    return posted;
  }
}
