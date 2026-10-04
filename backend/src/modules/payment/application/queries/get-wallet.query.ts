import { Inject, Injectable } from '@nestjs/common';
import { PaymentErrors } from '../../domain/errors';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import { BASE_CURRENCY } from '../../domain/value-objects/currency.vo';
import { WalletAccountingService } from '../services/wallet-accounting.service';

/**
 * §9.4's `GET /wallet` — "balance (from ledger) + summary".
 *
 * What is **deliberately absent**: the wallet's ledger account id. It is an internal surrogate key,
 * a customer never needs it, and publishing it would invite a client to send one back. Everything
 * here is derived from the customer's own entries, so there is nothing else to leak — no provider
 * reference, no webhook payload, no counterpart account, no reconciliation metadata.
 */
export interface WalletView {
  balance: number;
  currency: string;
  /** Σ of every credit the wallet has ever received — top-ups and refunds alike. */
  totalCredited: number;
  /** Σ of every debit — checkout spends. */
  totalDebited: number;
  /** How many ledger entries make up the two figures above; the history's `total`. */
  transactionCount: number;
}

export interface GetWalletInput {
  /** Resolved from the access token by the caller — never a client-supplied field. */
  customerUserId: string;
  currency?: string;
}

/**
 * `GET /wallet` (§9.4). The balance is **derived**, every time, as `Σ credits − Σ debits` over the
 * customer's `CUSTOMER_WALLET` entries (§5.3, F-WAL-01 "balance derived from ledger").
 *
 * `account_balances` is deliberately not read, even though it exists and would be one row rather
 * than an aggregate. It is a rebuildable cache; if it ever drifted from the entries, serving it
 * here would show the customer a number the ledger disagrees with — and the ledger is the one that
 * decides whether their next spend succeeds.
 *
 * A customer who has never transacted has no `ledger_accounts` row yet. That is a zero balance, not
 * an error: the account is opened on first read through the same `findOrCreateAccount` path every
 * posting uses, so the wallet exists from the moment it is asked about.
 */
@Injectable()
export class GetWalletQuery {
  constructor(
    private readonly wallets: WalletAccountingService,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
  ) {}

  async execute(input: GetWalletInput): Promise<WalletView> {
    const customerUserId = (input.customerUserId ?? '').trim();
    if (!customerUserId) {
      throw PaymentErrors.validation('customerUserId is required.', { field: 'customerUserId' });
    }
    const currency = input.currency ?? BASE_CURRENCY;

    const account = await this.wallets.resolveWalletAccount(customerUserId, currency);
    const totals = await this.ledger.sumEntriesByAccount(account.id);
    // `take: 0` asks the paged reader for the count alone — one aggregate, rather than loading
    // every entry the wallet has ever seen just to measure the list.
    const { total } = await this.ledger.listEntriesByAccountId(account.id, { skip: 0, take: 0 });

    return {
      // The invariant, spelled out rather than delegated: credits minus debits, nothing else.
      balance: totals.credit - totals.debit,
      currency: totals.currency,
      totalCredited: totals.credit,
      totalDebited: totals.debit,
      transactionCount: total,
    };
  }
}
