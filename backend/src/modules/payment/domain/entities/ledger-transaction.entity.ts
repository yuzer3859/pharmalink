import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../enums';
import { PaymentErrors } from '../errors';
import { Currency } from '../value-objects/currency.vo';
import { Money } from '../value-objects/money.vo';

/**
 * A row of the chart of accounts (§5.1, §7 `ledger_accounts`). Identity is the natural key
 * `(type, ownerId, currency)`; `id` is only a surrogate.
 */
export interface LedgerAccountProps {
  id: string;
  type: LedgerAccountType;
  ownerId: string | null;
  currency: string;
  createdAt: Date;
}

/**
 * One immutable double-entry posting (§5.1, §7 `ledger_entries`). There is deliberately no
 * mutator anywhere in this module for this shape: a ledger row is written once and then only
 * ever read (ADR-006, §5.3).
 */
export interface LedgerEntryProps {
  id: string;
  transactionId: string;
  accountId: string;
  direction: LedgerDirection;
  amount: number;
  currency: string;
  createdAt: Date;
}

/** The header grouping a balanced set of entries (§5.1, §7 `ledger_transactions`). */
export interface LedgerTransactionProps {
  id: string;
  reference: string;
  type: LedgerTransactionType;
  refType: string | null;
  refId: string | null;
  description: string | null;
  createdAt: Date;
}

/** A committed posting: the header plus every entry it wrote, in the order they were drafted. */
export interface PostedLedgerTransaction {
  transaction: LedgerTransactionProps;
  entries: LedgerEntryProps[];
}

/** One side of a posting, as a caller drafts it — no ids yet, amount as `Money`. */
export interface LedgerEntryDraftInput {
  accountId: string;
  direction: LedgerDirection;
  amount: Money;
}

export interface NewLedgerTransactionInput {
  /** Unique, immutable business reference (BRULE-25, §7 `ledger_transactions.reference`). */
  reference: string;
  type: LedgerTransactionType;
  /** What this posting is *about* (`payment`, `refund`, `settlement`, …) and its id (§7). */
  refType?: string | null;
  refId?: string | null;
  description?: string | null;
  entries: LedgerEntryDraftInput[];
}

/** A validated entry, ready to persist. `amount` is guaranteed positive and in `currency`. */
export interface ValidatedLedgerEntry {
  accountId: string;
  direction: LedgerDirection;
  amount: Money;
}

const MAX_REFERENCE_LENGTH = 128;
const MAX_REF_TYPE_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;

function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw PaymentErrors.validation(`${field} must be a string when present.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > maxLength) {
    throw PaymentErrors.validation(`${field} must be at most ${maxLength} characters.`, { field });
  }
  return trimmed;
}

/**
 * A **validated, not-yet-persisted double-entry transaction** — the guarded core of the money
 * model (§5.3, §7's rationale, ADR-006).
 *
 * Everything that makes a posting legal is decided here, in pure code with no I/O, so the rules
 * are exhaustively unit-testable without a database:
 *
 *  1. a reference is present, trimmed and bounded (BRULE-25 — every transaction is uniquely
 *     referenced; *uniqueness itself* is the database's `ledger_transactions.reference` unique
 *     index, which no application check can substitute for);
 *  2. the transaction is not empty, and carries at least one DEBIT **and** one CREDIT — with
 *     strictly positive amounts, no other shape can ever balance;
 *  3. every entry names an account, a direction, and a strictly positive amount that fits in the
 *     `Int` money column (zero and negative postings are rejected — a zero posting records
 *     nothing, and a negative one is a debit/credit written the wrong way round);
 *  4. every entry is in the same currency (no cross-currency transaction: converting is an
 *     explicit `FX` posting, §8, never an implicit side effect);
 *  5. **Σ debits = Σ credits** — the invariant the whole design rests on. A posting that does not
 *     balance is rejected *before* it can reach the database (`LEDGER_UNBALANCED`, §12).
 *
 * The class holds no account semantics: it does not know that a capture debits gateway clearing
 * and credits provider payable + platform revenue. That composition belongs to the money commands
 * (§11.3), so the ledger stays a general-purpose, correct-by-construction accounting primitive —
 * the design's example (`DEBIT Gateway-Clearing 100 / CREDIT Provider-Payable 90 / CREDIT
 * Platform-Revenue 10`) is simply one balanced instance of it, not a hard-coded case.
 */
export class LedgerTransactionDraft {
  private constructor(
    readonly reference: string,
    readonly type: LedgerTransactionType,
    readonly refType: string | null,
    readonly refId: string | null,
    readonly description: string | null,
    readonly entries: readonly ValidatedLedgerEntry[],
    readonly currency: Currency,
    /** Σ debits (== Σ credits) — the posting's magnitude. */
    readonly total: Money,
  ) {}

  static create(input: NewLedgerTransactionInput): LedgerTransactionDraft {
    const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
    if (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH) {
      throw PaymentErrors.validation(
        `Ledger transaction reference is required and must be at most ${MAX_REFERENCE_LENGTH} characters.`,
        { field: 'reference' },
      );
    }
    if (!Object.values(LedgerTransactionType).includes(input.type)) {
      throw PaymentErrors.validation('Unknown ledger transaction type.', {
        field: 'type',
        value: input.type,
      });
    }

    const drafts = input.entries;
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw PaymentErrors.validation(
        'A ledger transaction must post at least one debit and one credit entry.',
        { field: 'entries' },
      );
    }

    const currency = drafts[0]?.amount?.currency;
    if (!(currency instanceof Currency)) {
      throw PaymentErrors.validation('Every ledger entry requires a Money amount.', {
        field: 'entries[0].amount',
      });
    }

    const entries: ValidatedLedgerEntry[] = drafts.map((draft, index) =>
      LedgerTransactionDraft.validateEntry(draft, index, currency),
    );

    const debit = LedgerTransactionDraft.totalFor(entries, LedgerDirection.DEBIT, currency);
    const credit = LedgerTransactionDraft.totalFor(entries, LedgerDirection.CREDIT, currency);

    if (debit.isZero || credit.isZero) {
      throw PaymentErrors.validation(
        'A ledger transaction must post at least one debit and one credit entry.',
        { field: 'entries', debit: debit.amountMinor, credit: credit.amountMinor },
      );
    }
    if (!debit.equals(credit)) {
      throw PaymentErrors.ledgerUnbalanced({
        debit: debit.amountMinor,
        credit: credit.amountMinor,
        currency: currency.code,
      });
    }

    return new LedgerTransactionDraft(
      reference,
      input.type,
      optionalText(input.refType, 'refType', MAX_REF_TYPE_LENGTH),
      optionalText(input.refId, 'refId', MAX_REF_TYPE_LENGTH),
      optionalText(input.description, 'description', MAX_DESCRIPTION_LENGTH),
      entries,
      currency,
      debit,
    );
  }

  /** Distinct accounts this posting touches — the accounts whose derived balance changes. */
  affectedAccountIds(): string[] {
    return [...new Set(this.entries.map((entry) => entry.accountId))];
  }

  private static validateEntry(
    draft: LedgerEntryDraftInput,
    index: number,
    currency: Currency,
  ): ValidatedLedgerEntry {
    const at = `entries[${index}]`;
    if (draft === null || typeof draft !== 'object') {
      throw PaymentErrors.validation('Every ledger entry must be an object.', { field: at });
    }
    const accountId = typeof draft.accountId === 'string' ? draft.accountId.trim() : '';
    if (accountId.length === 0) {
      throw PaymentErrors.validation('Every ledger entry must name an account.', {
        field: `${at}.accountId`,
      });
    }
    if (!Object.values(LedgerDirection).includes(draft.direction)) {
      throw PaymentErrors.validation('Every ledger entry must be a DEBIT or a CREDIT.', {
        field: `${at}.direction`,
        value: draft.direction,
      });
    }
    if (!(draft.amount instanceof Money)) {
      throw PaymentErrors.validation('Every ledger entry requires a Money amount.', {
        field: `${at}.amount`,
      });
    }
    if (!draft.amount.isPositive) {
      throw PaymentErrors.validation(
        'A ledger entry amount must be strictly positive — direction, not sign, carries the debit/credit meaning.',
        { field: `${at}.amount`, value: draft.amount.amountMinor },
      );
    }
    draft.amount.assertPersistable(`${at}.amount`);
    if (!draft.amount.currency.equals(currency)) {
      throw PaymentErrors.validation(
        `All entries in a ledger transaction must share one currency (expected ${currency}, got ${draft.amount.currency}).`,
        {
          field: `${at}.amount`,
          expected: currency.code,
          actual: draft.amount.currency.code,
        },
      );
    }
    return { accountId, direction: draft.direction, amount: draft.amount };
  }

  private static totalFor(
    entries: readonly ValidatedLedgerEntry[],
    direction: LedgerDirection,
    currency: Currency,
  ): Money {
    return Money.sum(
      entries.filter((entry) => entry.direction === direction).map((entry) => entry.amount),
      currency,
    );
  }
}
