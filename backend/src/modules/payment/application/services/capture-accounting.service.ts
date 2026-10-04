import { Inject, Injectable } from '@nestjs/common';
import { LedgerEntryDraftInput } from '../../domain/entities/ledger-transaction.entity';
import { PaymentProps } from '../../domain/entities/payment.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  LedgerTransactionType,
} from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { CaptureSplit, FeeCalculator } from '../../domain/services/fee-calculator';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRef } from '../../domain/value-objects/account-ref.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { IOrderPort, ORDER_PORT } from '../ports/outbound/order.port';

/**
 * The capture posting's deterministic reference. `ledger_transactions.reference` is `@unique`
 * (BRULE-25, §7), so this doubles as the database-level guarantee that **one payment can produce
 * at most one capture posting**, no matter how many code paths try — the local capture command,
 * a capture webhook, or both racing.
 */
export function captureLedgerReference(paymentId: string): string {
  return `CAPTURE-${paymentId}`;
}

/** Everything a caller needs to report and audit a capture posting. */
export interface CapturePosting {
  reference: string;
  split: CaptureSplit;
}

/**
 * §11.3's capture accounting, in one place.
 *
 * Capture money can now be finalized by two different paths — `CapturePaymentCommand` (we asked
 * the gateway and it said yes) and `ProcessWebhookCommand` (the gateway told us unprompted). Both
 * must post *identically*: same accounts, same fee split, same reference. Duplicating that in two
 * commands would be two implementations of one piece of money arithmetic, free to drift apart —
 * so it lives here and both call it.
 *
 * This service owns no state-machine logic and performs no transition. It resolves the provider
 * account owner, computes the split, resolves accounts and posts through `LedgerService`; the
 * caller owns the transaction, the `Payment` transition, the audit entry and the event.
 */
@Injectable()
export class CaptureAccountingService {
  constructor(
    @Inject(ORDER_PORT) private readonly orders: IOrderPort,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Computes the capture split for a payment, resolving the fee from its order.
   *
   * Deliberately separate from {@link post}: callers resolve this *before* any external call, so
   * a fee or provider-account resolution failure surfaces before money moves rather than after.
   */
  async resolveSplit(payment: PaymentProps): Promise<CaptureSplit> {
    const order = await this.orders.getOrder(payment.orderId);
    if (!order) {
      throw PaymentErrors.orderNotFound({ orderId: payment.orderId });
    }
    return FeeCalculator.splitCapture({
      gross: Money.of(payment.amount, payment.currency),
      platformFee: Money.of(order.platformFee, order.currency),
      // ADR-019 — platform-funded. Read back off the order, never re-derived from
      // `coupon_redemptions`: `grandTotal` was computed from *this* number inside Module 06's
      // checkout transaction, so it is the only value that reconciles against what the customer
      // agreed to. `0` for every order today, since checkout has no coupon step yet.
      discountTotal: Money.of(order.discountTotal, order.currency),
    });
  }

  /**
   * The `PROVIDER_PAYABLE` owner comes from Module 06's `Fulfillment.pharmacyId` — written by the
   * checkout saga from Module 05's chosen match, so it is platform-determined. No caller, and no
   * webhook payload, ever supplies it; accepting one would let a request redirect a payout.
   */
  async resolveProviderPharmacyId(orderId: string): Promise<string> {
    const distinct = [...new Set(await this.orders.getFulfillmentPharmacyIds(orderId))];
    if (distinct.length !== 1) {
      // Zero: nothing identifies the provider. More than one: §11.3's posting credits a single
      // PROVIDER_PAYABLE and the design defines no split rule — guessing would mis-pay providers.
      throw PaymentErrors.providerPayableUnresolved(orderId, distinct.length);
    }
    return distinct[0];
  }

  /**
   * Posts §11.3's balanced capture transaction inside the caller's transaction:
   *
   * ```
   * DEBIT  Gateway-Clearing   gross                 (what the customer actually paid)
   * DEBIT  Promotion-Expense  D                     (ADR-019 — omitted when D = 0)
   * CREDIT Provider-Payable   gross − fee + D       (as if there had been no coupon)
   * CREDIT Platform-Revenue   fee                   (Order.platformFee, unchanged)
   * ```
   *
   * The promotion leg is what makes the posting balance once the pharmacy is paid an amount the
   * customer did not hand over: without it, credits would exceed debits by exactly `D`. It is
   * therefore not optional bookkeeping colour — it is the counterweight to the discount, and the
   * reason `PROVIDER_PAYABLE` can be left un-reduced (ADR-019).
   *
   * A zero-value leg is omitted rather than posted — the ledger rejects zero entries. A zero fee
   * simply means the whole gross is payable, and a zero discount (every order today) collapses
   * this back to exactly the three-leg posting that existed before ADR-019 was resolved, so no
   * historical capture is reinterpreted.
   *
   * Every posting goes through `LedgerService`; no caller writes ledger rows directly, and
   * nothing here touches `account_balances` (the repository refreshes that cache itself).
   */
  async post(
    payment: PaymentProps,
    split: CaptureSplit,
    pharmacyId: string,
    tx: unknown,
  ): Promise<CapturePosting> {
    const accounts = await this.resolveAccounts(
      pharmacyId,
      payment.currency,
      split.promotionExpense.isPositive,
      tx,
    );
    const reference = captureLedgerReference(payment.id);

    const entries: LedgerEntryDraftInput[] = [
      { accountId: accounts.gateway, direction: LedgerDirection.DEBIT, amount: split.gross },
      ...(split.promotionExpense.isPositive && accounts.promotion
        ? [
            {
              accountId: accounts.promotion,
              direction: LedgerDirection.DEBIT,
              amount: split.promotionExpense,
            },
          ]
        : []),
      ...(split.providerNet.isPositive
        ? [
            {
              accountId: accounts.payable,
              direction: LedgerDirection.CREDIT,
              amount: split.providerNet,
            },
          ]
        : []),
      ...(split.fee.isPositive
        ? [
            {
              accountId: accounts.revenue,
              direction: LedgerDirection.CREDIT,
              amount: split.fee,
            },
          ]
        : []),
    ];

    await this.ledger.post(
      {
        reference,
        type: LedgerTransactionType.CAPTURE,
        refType: 'payment',
        refId: payment.id,
        description: `Capture for order ${payment.orderId}`,
        entries,
      },
      tx,
    );

    return { reference, split };
  }

  /**
   * Accounts by natural key, never by hard-coded id (§7's chart of accounts).
   *
   * `PROMOTION_EXPENSE` is resolved only when the posting will actually debit it. Resolving opens
   * an account on first use, so resolving it unconditionally would create an empty
   * `PROMOTION_EXPENSE` row on the very first capture of an un-discounted order and leave it
   * there forever — the same reason `RefundAccountingService` resolves its clawback accounts
   * lazily.
   */
  private async resolveAccounts(
    pharmacyId: string,
    currency: string,
    needsPromotion: boolean,
    tx?: unknown,
  ): Promise<{ gateway: string; payable: string; revenue: string; promotion: string | null }> {
    const [gateway, payable, revenue, promotion] = await Promise.all([
      this.ledger.resolveAccount(
        AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, currency),
        tx,
      ),
      this.ledger.resolveAccount(AccountRef.providerPayable(pharmacyId, currency), tx),
      this.ledger.resolveAccount(
        AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE, currency),
        tx,
      ),
      needsPromotion
        ? this.ledger.resolveAccount(
            AccountRef.platform(LedgerAccountType.PROMOTION_EXPENSE, currency),
            tx,
          )
        : Promise.resolve(null),
    ]);
    return {
      gateway: gateway.id,
      payable: payable.id,
      revenue: revenue.id,
      promotion: promotion?.id ?? null,
    };
  }
}
