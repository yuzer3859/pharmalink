import { Inject, Injectable } from '@nestjs/common';
import { LedgerDirection, LedgerTransactionType } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import { BASE_CURRENCY } from '../../domain/value-objects/currency.vo';
import { WalletAccountingService } from '../services/wallet-accounting.service';

export const MAX_WALLET_PAGE_SIZE = 50;
export const DEFAULT_WALLET_PAGE_SIZE = 20;

/**
 * One row of §9.4's wallet history — one of the customer's own ledger entries, with the movement
 * it belonged to.
 *
 * What is **deliberately absent**:
 *
 *  - `accountId` and `transactionId` — internal surrogate keys (§12's rule that ledger internals
 *    stay inside Module 07, the same allow-list discipline `PaymentView` and `RefundView` apply);
 *  - **the counterpart legs** — the other side of every wallet movement is a platform or provider
 *    account, and which one is nobody's business but the platform's. Only the wallet's own entries
 *    are read, so there is no counterpart in the result to omit by accident;
 *  - provider references, tokens, raw webhook payloads and reconciliation metadata — none of them
 *    live on a ledger entry at all.
 *
 * `reference` *is* included: `WALLET-TOPUP-<paymentId>`, `WALLET-SPEND-<orderId>` or
 * `REFUND-<refundId>` is the handle a customer quotes to support, and it identifies a movement
 * rather than granting access to anything.
 */
export interface WalletTransactionView {
  reference: string;
  type: LedgerTransactionType;
  direction: LedgerDirection;
  /** Always positive minor units; `direction` carries the sign (§7's entry model). */
  amount: number;
  currency: string;
  description: string | null;
  /** What the movement was about — `payment`, `order`, `refund` — and its id (§7's `ref_type`). */
  relatedType: string | null;
  relatedId: string | null;
  createdAt: Date;
}

export interface ListWalletTransactionsInput {
  /** Resolved from the access token by the caller — never a client-supplied field. */
  customerUserId: string;
  currency?: string;
  page?: number;
  size?: number;
}

export interface WalletTransactionsView {
  items: WalletTransactionView[];
  total: number;
  page: number;
  size: number;
}

/**
 * `GET /wallet/transactions` (§9.4, F-WAL-03 "wallet transaction history").
 *
 * **Customer isolation is structural, not a filter.** The listing is built from the entries of the
 * account resolved from `(CUSTOMER_WALLET, customerUserId, currency)`, and `customerUserId` comes
 * from the access token. There is no code path that takes an account id, so customer A cannot
 * reach customer B's history by any input — not by guessing an id, because no id is accepted.
 *
 * Every movement that ever touched the wallet appears here, whatever wrote it: top-ups, checkout
 * spends and the refunds `RefundPaymentCommand` credits with `destination = WALLET`. The wallet
 * consumes existing ledger data; it keeps no history of its own for any of them to be missing from.
 */
@Injectable()
export class ListWalletTransactionsQuery {
  constructor(
    private readonly wallets: WalletAccountingService,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
  ) {}

  async execute(input: ListWalletTransactionsInput): Promise<WalletTransactionsView> {
    const customerUserId = (input.customerUserId ?? '').trim();
    if (!customerUserId) {
      throw PaymentErrors.validation('customerUserId is required.', { field: 'customerUserId' });
    }
    const currency = input.currency ?? BASE_CURRENCY;
    const page = Math.max(Math.trunc(input.page ?? 1), 1);
    const size = Math.min(
      Math.max(Math.trunc(input.size ?? DEFAULT_WALLET_PAGE_SIZE), 1),
      MAX_WALLET_PAGE_SIZE,
    );

    const account = await this.wallets.resolveWalletAccount(customerUserId, currency);
    const { items, total } = await this.ledger.listEntriesByAccountId(account.id, {
      skip: (page - 1) * size,
      take: size,
    });

    return {
      items: items.map(({ entry, transaction }) => ({
        reference: transaction.reference,
        type: transaction.type,
        direction: entry.direction,
        amount: entry.amount,
        currency: entry.currency,
        description: transaction.description,
        relatedType: transaction.refType,
        relatedId: transaction.refId,
        createdAt: entry.createdAt,
      })),
      total,
      page,
      size,
    };
  }
}
