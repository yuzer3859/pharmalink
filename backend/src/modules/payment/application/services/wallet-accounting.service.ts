import { Injectable } from '@nestjs/common';
import { LedgerAccountProps } from '../../domain/entities/ledger-transaction.entity';
import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRef } from '../../domain/value-objects/account-ref.vo';
import { Money } from '../../domain/value-objects/money.vo';

/**
 * The top-up posting's deterministic reference. `ledger_transactions.reference` is `@unique`
 * (BRULE-25, §7), so this doubles as the database-level guarantee that **one funding payment can
 * credit a wallet at most once**, however many code paths or concurrent retries try.
 */
export function walletTopUpReference(paymentId: string): string {
  return `WALLET-TOPUP-${paymentId}`;
}

/**
 * The spend posting's deterministic reference — one wallet spend per order, forever, enforced by
 * the same unique index. Deliberately keyed on the *order*, not on a caller-supplied key: the
 * order is what the spend is economically about, and a random reference would make a spend
 * impossible to match during reconciliation (§3.6).
 */
export function walletSpendReference(orderId: string): string {
  return `WALLET-SPEND-${orderId}`;
}

/** What a caller needs to report and audit a wallet posting. */
export interface WalletPosting {
  reference: string;
  amount: Money;
  /** The wallet balance derived *after* this posting, inside the same transaction. */
  balanceAfter: Money;
}

/**
 * Wallet accounting (§3.3, §11.6), in one place — the wallet's counterpart to
 * `CaptureAccountingService` and `RefundAccountingService`.
 *
 * ## The wallet is a projection, not a table
 *
 * There is no `wallets` table, no `wallet.balance` column and no `users.walletBalance`. §5.1 calls
 * the wallet "a projection over ledger for a customer account", and §5.3 forbids storing a balance
 * as an authoritative mutable field. A customer's wallet *is* their `CUSTOMER_WALLET` ledger
 * account, identified by the natural key `(CUSTOMER_WALLET, customerUserId, currency)` (§7), and
 * their balance is `Σ credits − Σ debits` over that account's immutable entries.
 *
 * `account_balances` is never read here. It is a rebuildable cache the repository refreshes on
 * posting, and a decision about money is made against the ledger itself — which is exactly what
 * `LedgerService.balanceOf` reads.
 *
 * ## Wallet holds are deliberately not implemented
 *
 * §3.3 F-WAL-03 mentions "holds/reservations for in-flight spends" in a single clause and the
 * design says nothing else about them anywhere: no hold state, no hold entity in §5.1, no hold
 * table in §7, no `HOLD` value in §7's `ledger_transactions.type` enum, no expiry rule, no release
 * trigger, and no flow in §11. Two incompatible mechanisms would satisfy that clause — a
 * `WALLET_HOLD` ledger account that funds are posted into and released from, or a reservation
 * table consulted alongside the derived balance — and choosing between them decides real financial
 * behaviour (what happens to a hold whose order is abandoned; whether a held amount is visible in
 * the customer's balance; who may release one).
 *
 * Nothing is invented here. Spend is atomic against the derived balance instead, which is what
 * §11.6 actually specifies, and needs no hold to be correct: the balance check and the debit
 * happen inside one `Serializable` transaction, so an in-flight spend cannot be double-funded.
 */
@Injectable()
export class WalletAccountingService {
  constructor(private readonly ledger: LedgerService) {}

  /**
   * Resolves the customer's wallet ledger account, opening it on first use.
   *
   * Identity is always `(CUSTOMER_WALLET, customerUserId, currency)`. No caller anywhere in this
   * module passes a ledger account id for a wallet, and no HTTP surface accepts one — a client
   * that could name an account could name someone else's.
   */
  resolveWalletAccount(
    customerUserId: string,
    currency: string,
    tx?: unknown,
  ): Promise<LedgerAccountProps> {
    return this.ledger.resolveAccount(AccountRef.customerWallet(customerUserId, currency), tx);
  }

  /**
   * The customer's balance, derived from `ledger_entries` as `Σ credits − Σ debits` (§5.3),
   * reflecting **every** movement the account has ever seen: top-ups, checkout spends, and the
   * refunds `RefundPaymentCommand` credits with `destination = WALLET`. There is no second wallet
   * accounting system for any of them to be missing from.
   */
  async balanceOf(customerUserId: string, currency: string, tx?: unknown): Promise<Money> {
    const account = await this.resolveWalletAccount(customerUserId, currency, tx);
    return this.ledger.balanceOf(account.id, tx);
  }

  /**
   * §11.6's mirror image: `DEBIT Gateway-Clearing`, `CREDIT Customer-Wallet`.
   *
   * The gateway-clearing debit is what makes the credit *backed*: it says money arrived through
   * the gateway and now belongs to this customer, exactly as a capture's gateway-clearing debit
   * says money arrived and now belongs to a pharmacy. A wallet credit with no debit source would
   * be money created from nothing, and `LedgerService` would reject the unbalanced posting anyway.
   */
  async postTopUp(
    input: { customerUserId: string; paymentId: string; amount: Money },
    tx: unknown,
  ): Promise<WalletPosting> {
    const { wallet, gateway } = await this.resolveAccounts(
      input.customerUserId,
      input.amount.currency.code,
      tx,
    );
    const reference = walletTopUpReference(input.paymentId);

    await this.ledger.post(
      {
        reference,
        type: LedgerTransactionType.WALLET_TOPUP,
        refType: 'payment',
        refId: input.paymentId,
        description: 'Wallet top-up',
        entries: [
          { accountId: gateway, direction: LedgerDirection.DEBIT, amount: input.amount },
          { accountId: wallet, direction: LedgerDirection.CREDIT, amount: input.amount },
        ],
      },
      tx,
    );

    return {
      reference,
      amount: input.amount,
      balanceAfter: await this.ledger.balanceOf(wallet, tx),
    };
  }

  /**
   * §11.6 verbatim: `DEBIT Customer-Wallet`, `CREDIT Gateway-Clearing`.
   *
   * **The balance check lives inside this method, against the same `tx` as the debit**, and that
   * placement is the whole concurrency story. Reading the balance in one transaction and writing
   * the debit in another is the textbook write-skew: two concurrent spends each see the same
   * funds, each find their amount affordable, and together overdraw. Doing both inside one
   * `Serializable` transaction is what closes it — PostgreSQL's SSI detects that each transaction
   * wrote into the range the other summed and aborts one. There is no application mutex, and there
   * could not be one: the database is the concurrency boundary.
   */
  async postSpend(
    input: { customerUserId: string; orderId: string; amount: Money },
    tx: unknown,
  ): Promise<WalletPosting> {
    const currency = input.amount.currency.code;
    const { wallet, gateway } = await this.resolveAccounts(input.customerUserId, currency, tx);

    // Derived from the entries, in this transaction. Never `account_balances`.
    const available = await this.ledger.balanceOf(wallet, tx);
    if (available.isLessThan(input.amount)) {
      throw PaymentErrors.insufficientWalletBalance({
        customerUserId: input.customerUserId,
        requested: input.amount.amountMinor,
        available: available.amountMinor,
        currency,
      });
    }

    const reference = walletSpendReference(input.orderId);
    await this.ledger.post(
      {
        reference,
        type: LedgerTransactionType.WALLET_SPEND,
        refType: 'order',
        refId: input.orderId,
        description: `Wallet spend for order ${input.orderId}`,
        entries: [
          { accountId: wallet, direction: LedgerDirection.DEBIT, amount: input.amount },
          { accountId: gateway, direction: LedgerDirection.CREDIT, amount: input.amount },
        ],
      },
      tx,
    );

    const balanceAfter = await this.ledger.balanceOf(wallet, tx);
    if (balanceAfter.isNegative) {
      // Unreachable given the check above, and asserted anyway: a negative wallet is the one
      // outcome this command must never commit, so it fails the transaction rather than trusting
      // that the guard was correct. Not clamped — a wrong balance is a defect, not a value to fix.
      throw PaymentErrors.insufficientWalletBalance({
        customerUserId: input.customerUserId,
        requested: input.amount.amountMinor,
        available: available.amountMinor,
        currency,
      });
    }

    return { reference, amount: input.amount, balanceAfter };
  }

  /** Accounts by natural key, never by hard-coded or caller-supplied id (§7's chart of accounts). */
  private async resolveAccounts(
    customerUserId: string,
    currency: string,
    tx: unknown,
  ): Promise<{ wallet: string; gateway: string }> {
    const [wallet, gateway] = await Promise.all([
      this.resolveWalletAccount(customerUserId, currency, tx),
      this.ledger.resolveAccount(
        AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, currency),
        tx,
      ),
    ]);
    return { wallet: wallet.id, gateway: gateway.id };
  }
}
