import { LedgerAccountType } from '../enums';
import { PaymentErrors } from '../errors';
import { BASE_CURRENCY, Currency } from './currency.vo';

/**
 * The persistence-facing shape of an `AccountRef` — exactly the `ledger_accounts` natural key
 * (`@@unique([type, ownerId, currency])`, §7). Repository contracts speak this plain shape so no
 * value object leaks into the persistence port (the same discipline every Module 04/05/06
 * repository snapshot follows).
 */
export interface AccountRefKey {
  type: LedgerAccountType;
  ownerId: string | null;
  currency: string;
}

/**
 * Account types that are meaningless without an owner: a wallet belongs to a customer, a payable
 * belongs to a provider (§7 — "`owner_id` (nullable: user/pharmacy)"). The remaining types
 * (`PLATFORM_REVENUE`, `GATEWAY_CLEARING`, `REFUNDS_PAYABLE`, `COD_CLEARING`, `FX_GAINLOSS`,
 * `PROMOTION_EXPENSE`) are
 * platform-level today but are *not* forced to have a null owner — COD clearing in particular is
 * expected to gain a per-driver dimension when Module 08 reconciles driver cash (§Open Questions
 * 5), and pre-emptively forbidding that would be inventing a rule the design does not state.
 */
const OWNER_REQUIRED: ReadonlySet<LedgerAccountType> = new Set([
  LedgerAccountType.CUSTOMER_WALLET,
  LedgerAccountType.PROVIDER_PAYABLE,
]);

/**
 * `AccountRef` (§5.2) — `type + ownerId (+ currency)`, the identity of a ledger account
 * independent of its surrogate `id`. Lets a money command name the account it wants
 * ("this customer's wallet") and let `LedgerService` resolve or open it, instead of every caller
 * carrying account UUIDs around.
 */
export class AccountRef {
  private constructor(
    readonly type: LedgerAccountType,
    readonly ownerId: string | null,
    readonly currency: Currency,
  ) {}

  static of(props: {
    type: LedgerAccountType;
    ownerId?: string | null;
    currency?: string | Currency;
  }): AccountRef {
    if (!Object.values(LedgerAccountType).includes(props.type)) {
      throw PaymentErrors.validation('Unknown ledger account type.', {
        field: 'type',
        value: props.type,
      });
    }
    const rawOwner = props.ownerId ?? null;
    const ownerId = typeof rawOwner === 'string' ? rawOwner.trim() : rawOwner;
    if (ownerId !== null && ownerId.length === 0) {
      throw PaymentErrors.validation('ownerId must be a non-empty string when present.', {
        field: 'ownerId',
      });
    }
    if (ownerId === null && OWNER_REQUIRED.has(props.type)) {
      throw PaymentErrors.validation(`A ${props.type} account requires an ownerId.`, {
        field: 'ownerId',
        type: props.type,
      });
    }
    const currency =
      props.currency instanceof Currency
        ? props.currency
        : Currency.of(props.currency ?? BASE_CURRENCY);
    return new AccountRef(props.type, ownerId, currency);
  }

  static customerWallet(userId: string, currency?: string | Currency): AccountRef {
    return AccountRef.of({ type: LedgerAccountType.CUSTOMER_WALLET, ownerId: userId, currency });
  }

  static providerPayable(pharmacyId: string, currency?: string | Currency): AccountRef {
    return AccountRef.of({
      type: LedgerAccountType.PROVIDER_PAYABLE,
      ownerId: pharmacyId,
      currency,
    });
  }

  /** A platform-level account (no owner) — revenue, gateway clearing, refunds payable, … */
  static platform(type: LedgerAccountType, currency?: string | Currency): AccountRef {
    return AccountRef.of({ type, ownerId: null, currency });
  }

  equals(other: AccountRef): boolean {
    return (
      this.type === other.type &&
      this.ownerId === other.ownerId &&
      this.currency.equals(other.currency)
    );
  }

  toKey(): AccountRefKey {
    return { type: this.type, ownerId: this.ownerId, currency: this.currency.code };
  }

  toString(): string {
    return `${this.type}:${this.ownerId ?? '-'}:${this.currency.code}`;
  }
}
