import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../enums';
import { PaymentErrors } from '../errors';

/** One leg of a posting, with its account already resolved. */
export interface ClassifiedLeg {
  accountType: LedgerAccountType;
  /** `pharmacyId` for a `PROVIDER_PAYABLE`, `userId` for a wallet, `null` for platform accounts. */
  ownerId: string | null;
  direction: LedgerDirection;
  amount: number;
  currency: string;
}

/** A committed posting that touched the pharmacy's payable, with every leg it wrote. */
export interface SettleableTransaction {
  transactionId: string;
  reference: string;
  type: LedgerTransactionType;
  refType: string | null;
  refId: string | null;
  occurredAt: Date;
  legs: ClassifiedLeg[];
}

/**
 * One statement line — a single ledger posting, projected onto the four figures a statement has
 * to show separately. Every field is a **signed delta in minor units**, so a capture and the
 * refund that reverses it are the same shape with opposite signs and simply sum.
 */
export interface SettlementLineFigures {
  /**
   * What this posting moved into (+) or out of (−) the pharmacy's `PROVIDER_PAYABLE`.
   * **This, and only this, is what the pharmacy is owed.**
   */
  providerPayableDelta: number;
  /** Platform commission earned (+) or clawed back (−) on this posting. Never nets into the above. */
  platformRevenueDelta: number;
  /** Platform-funded coupon expense incurred (+) or released (−). Never nets into either of the above. */
  promotionExpenseDelta: number;
  /** Customer cash collected (+) or returned (−), via `GATEWAY_CLEARING`. Context, never payable. */
  customerCashDelta: number;
}

export interface SettlementLineDraft extends SettlementLineFigures {
  transactionId: string;
  reference: string;
  type: LedgerTransactionType;
  refType: string | null;
  refId: string | null;
  occurredAt: Date;
  currency: string;
}

/** The statement totals — the same four figures, summed, plus the net. */
export interface SettlementTotals {
  /** Σ of the positive `providerPayableDelta`s: what was accrued to the pharmacy this period. */
  providerPayableGross: number;
  /** Σ of the negative ones, as a positive number: refunds and reversals taken back. */
  providerRefundClawback: number;
  /** `providerPayableGross − providerRefundClawback`. What is actually payable. */
  netPayable: number;
  platformRevenue: number;
  promotionExpense: number;
  customerCashCollected: number;
  lineCount: number;
}

/**
 * `SettlementCalculator` (§10's `domain/services/SettlementCalculator`) — the pure arithmetic
 * behind a settlement statement. No I/O, no Prisma, no configuration reads: it is handed postings
 * that already happened and projects them.
 *
 * ## It computes nothing about pricing, on purpose
 *
 * A settlement never re-derives an order total, a platform fee or a coupon discount. It reads what
 * the capture actually posted. That is not a stylistic preference: a fee re-derived from today's
 * configuration would differ from the one the customer was charged the moment a rate changed
 * (which is exactly why `FeeCalculator` reads `Order.platformFee` rather than a percentage), and a
 * statement that disagreed with the ledger it is supposedly summarizing would be worse than no
 * statement at all. The ledger is immutable (ADR-006), so a statement derived from it is
 * reproducible forever; one derived from configuration is only reproducible until someone edits
 * the configuration.
 *
 * ## Why the four figures stay separate
 *
 * The pharmacy is paid `providerPayableDelta` and nothing else. Under ADR-019's platform-funded
 * coupons the customer may have paid **less** than that — for a 2,000 discount the gateway
 * collected 8,450 while the payable was credited 10,000, the 1,550 difference being the platform's
 * promotional spend net of its commission. Paying the pharmacy out of cash collected would
 * therefore short it by exactly the discount the platform promised to fund.
 *
 * So `promotionExpenseDelta` and `platformRevenueDelta` are carried for visibility and are
 * **never** added to or subtracted from the payable. Collapsing them into one "net settlement"
 * number would hide which of three different things moved — and would make a promotion running at
 * a loss (commission 450 against expense 2,000) indistinguishable from a smaller order.
 */
export const SettlementCalculator = {
  /**
   * Projects one posting onto the statement's four figures.
   *
   * Sign conventions follow the account's natural side, so a positive number always means "more
   * of this thing happened":
   *
   *  - payable and revenue are **liability/revenue** accounts, credited when they grow, so their
   *    delta is `credits − debits`;
   *  - promotion expense and gateway clearing are **expense/asset** accounts, debited when they
   *    grow, so their delta is `debits − credits`.
   *
   * Legs belonging to another pharmacy's payable are ignored rather than summed — a posting
   * cannot legitimately credit two providers today (`CaptureAccountingService` refuses an order
   * with more than one fulfillment pharmacy), and silently folding one into another's statement
   * would misdirect a payout.
   */
  lineFor(
    transaction: SettleableTransaction,
    pharmacyId: string,
    currency: string,
  ): SettlementLineDraft {
    let providerPayableDelta = 0;
    let platformRevenueDelta = 0;
    let promotionExpenseDelta = 0;
    let customerCashDelta = 0;

    for (const leg of transaction.legs) {
      if (leg.currency !== currency) {
        // Multi-currency settlement is undefined (§8's FX handling is its own unbuilt concern),
        // and quietly adding minor units across currencies would produce a meaningless total.
        throw PaymentErrors.validation(
          'A settleable posting mixes currencies; settlement is single-currency.',
          { transactionId: transaction.transactionId, expected: currency, found: leg.currency },
        );
      }
      const credit = leg.direction === LedgerDirection.CREDIT ? leg.amount : 0;
      const debit = leg.direction === LedgerDirection.DEBIT ? leg.amount : 0;

      switch (leg.accountType) {
        case LedgerAccountType.PROVIDER_PAYABLE:
          if (leg.ownerId === pharmacyId) {
            providerPayableDelta += credit - debit;
          }
          break;
        case LedgerAccountType.PLATFORM_REVENUE:
          platformRevenueDelta += credit - debit;
          break;
        case LedgerAccountType.PROMOTION_EXPENSE:
          promotionExpenseDelta += debit - credit;
          break;
        case LedgerAccountType.GATEWAY_CLEARING:
          customerCashDelta += debit - credit;
          break;
        default:
          // Wallet, COD clearing, FX and refunds-payable legs are real and may appear (a refund
          // to wallet credits CUSTOMER_WALLET instead of GATEWAY_CLEARING). None of them is one
          // of the four figures a statement reports, and none affects the payable, so they are
          // deliberately not folded into `customerCashDelta` — that field means "cash through the
          // gateway", and widening it would make the statement claim cash moved when it did not.
          break;
      }
    }

    return {
      transactionId: transaction.transactionId,
      reference: transaction.reference,
      type: transaction.type,
      refType: transaction.refType,
      refId: transaction.refId,
      occurredAt: transaction.occurredAt,
      currency,
      providerPayableDelta,
      platformRevenueDelta,
      promotionExpenseDelta,
      customerCashDelta,
    };
  },

  /**
   * Sums lines into statement totals.
   *
   * `providerPayableGross` and `providerRefundClawback` split the payable by sign rather than
   * reporting one net figure, because BRULE-23 states the payout as "order revenue − platform fee
   * − refunds clawback" and a statement a pharmacy can check has to show the clawback it is
   * being charged, not just the answer.
   */
  totals(lines: readonly SettlementLineDraft[]): SettlementTotals {
    let providerPayableGross = 0;
    let providerRefundClawback = 0;
    let platformRevenue = 0;
    let promotionExpense = 0;
    let customerCashCollected = 0;

    for (const line of lines) {
      if (line.providerPayableDelta >= 0) {
        providerPayableGross += line.providerPayableDelta;
      } else {
        providerRefundClawback += -line.providerPayableDelta;
      }
      platformRevenue += line.platformRevenueDelta;
      promotionExpense += line.promotionExpenseDelta;
      customerCashCollected += line.customerCashDelta;
    }

    return {
      providerPayableGross,
      providerRefundClawback,
      netPayable: providerPayableGross - providerRefundClawback,
      platformRevenue,
      promotionExpense,
      customerCashCollected,
      lineCount: lines.length,
    };
  },
};
