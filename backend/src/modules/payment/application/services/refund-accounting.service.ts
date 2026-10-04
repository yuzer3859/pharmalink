import { Inject, Injectable } from '@nestjs/common';
import {
  LedgerEntryDraftInput,
  PostedLedgerTransaction,
} from '../../domain/entities/ledger-transaction.entity';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { RefundProps } from '../../domain/entities/refund.entity';
import {
  LedgerAccountType,
  LedgerDirection,
  LedgerTransactionType,
  RefundDestination,
} from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import {
  IRefundRepository,
  REFUND_REPOSITORY,
} from '../../domain/repositories/refund.repository';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRef } from '../../domain/value-objects/account-ref.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { allocateProportionally } from '../../domain/value-objects/proportional-allocation';
import { captureLedgerReference } from './capture-accounting.service';

/**
 * The refund posting's deterministic reference. `ledger_transactions.reference` is `@unique`
 * (BRULE-25, §7), so this doubles as the database-level guarantee that **one refund can produce at
 * most one ledger posting**, no matter how many code paths try — the command, a retry that resumed
 * a `PENDING` refund, or both racing.
 *
 * Keyed on `refundId`, not `paymentId`: a payment may have several legitimate partial refunds, and
 * a payment-scoped reference would make the second one collide with the first and be silently
 * swallowed as a duplicate.
 */
export function refundLedgerReference(refundId: string): string {
  return `REFUND-${refundId}`;
}

/**
 * How one refund's amount is taken back out of the accounts the capture credited.
 *
 * `providerClawback + feeClawback === amount + promotionClawback` always — that identity is what
 * makes the posting balance. Before ADR-019 the promotion term was absent and the identity was the
 * simpler `providerClawback + feeClawback === amount`; it still reads that way for every refund of
 * a capture with no coupon, because `promotionClawback` is then zero.
 */
export interface RefundSplit {
  /** Total returned to the customer, by whichever destination. */
  amount: Money;
  /** Debited from the pharmacy's `PROVIDER_PAYABLE` (BRULE-23's refunds clawback). */
  providerClawback: Money;
  /** Debited from `PLATFORM_REVENUE` — the commission given back with the refund. */
  feeClawback: Money;
  /**
   * **Credited** back to `PROMOTION_EXPENSE` — the platform-funded discount the refund un-spends
   * (ADR-019). Zero for a capture that posted no promotion leg, which is every capture today.
   *
   * Its direction is the opposite of the other two: the capture *debited* the expense, so
   * reversing it credits the expense back. That is also why the refund's debits no longer sum to
   * `amount` — see {@link computeRefundSplit}.
   */
  promotionClawback: Money;
}

/** Everything a caller needs to report and audit a refund posting. */
export interface RefundPosting {
  reference: string;
  split: RefundSplit;
  posted: PostedLedgerTransaction;
}

/**
 * The authoritative capture legs, read back off the committed capture posting — the historical
 * allocation a refund reverses (ADR-016 §"Reuse the actual capture accounting").
 *
 * `pharmacyId` is nullable for one degenerate but reachable shape: a capture whose platform fee
 * equalled the gross credits no `PROVIDER_PAYABLE` at all (`CaptureAccountingService` omits zero
 * legs), so there is no payable owner to read. Such a capture also has nothing to claw back from a
 * payable — see `computeRefundSplit` — so the absence is consistent rather than a gap.
 */
export interface CapturedLegs {
  gross: Money;
  providerNet: Money;
  fee: Money;
  /**
   * The `PROMOTION_EXPENSE` debit the capture posted — the platform-funded discount (ADR-019).
   * Zero for a capture posted before ADR-019 was resolved, or for any order with no coupon, which
   * makes every historical capture reverse exactly as it did before.
   */
  promotionExpense: Money;
  pharmacyId: string | null;
}

/**
 * ADR-016's clawback, as a pure function of the historical capture and the refund history.
 *
 * ```
 * feeClawback       = round(F x (P + r) / G) - round(F x P / G)
 * promotionClawback = round(E x (P + r) / G) - round(E x P / G)
 * providerClawback  = r + promotionClawback - feeClawback
 * ```
 *
 * `F`, `E` and `G` are the platform-revenue, promotion-expense and gateway-clearing legs the
 * capture actually posted, `P` is the amount already refunded **and posted** before this refund,
 * and `r` is this refund. `E` is `0` for every capture with no coupon, and the whole thing then
 * collapses to exactly ADR-016's original two-term formula — no historical refund changes.
 *
 * ## Why the promotion term appears on the provider leg
 *
 * The capture *debited* `E`, so reversing it *credits* `E` back. A refund of `r` therefore no
 * longer has debits summing to `r`; it has `debits = r + promotionClawback`. Under ADR-019 the
 * pharmacy was credited `G - F + E`, i.e. it was paid the discount too, so a refund must take that
 * share back from the pharmacy as well — which is precisely what `+ promotionClawback` on the
 * provider leg does. Defining the provider leg as the remainder keeps the posting balanced by
 * construction whatever the rounding did, exactly as before.
 *
 * ## Why cumulative, and why that is the whole trick
 *
 * Rounding each refund's share independently lets residues accumulate: a payment refunded to 100%
 * in several increments could leave `PLATFORM_REVENUE` permanently non-zero — a ledger that never
 * reconciles. Computing the *cumulative* clawback and subtracting the previous cumulative value
 * makes the roundings telescope, so
 *
 * ```
 * Σ feeClawback       = round(F x G / G) - round(0) = F
 * Σ promotionClawback = round(E x G / G) - round(0) = E
 * Σ providerClawback  = G + E - F                   = the payable leg the capture credited
 * ```
 *
 * exactly, for **any** number, order and size of partial refunds — so a payment refunded to 100%
 * in increments returns all three capture legs to zero, including the promotion expense. The final
 * refund absorbs the residue as a consequence of the arithmetic — nothing anywhere asks "is this
 * the last one?", and no residue is stored (ADR-006 forbids a second mutable source of truth about
 * money).
 *
 * ## The balancing leg and the tripwire
 *
 * `providerClawback` is defined as the remainder, so the two debits always sum to exactly `r` and
 * the posting balances whatever rounding did. That makes `0 <= feeClawback <= r` the one property
 * worth asserting: it holds for every `F <= G` (the invariant a balanced capture guarantees), so a
 * violation means the inputs are not a capture allocation at all. It is raised as
 * `LEDGER_UNBALANCED` — a defect tripwire — and deliberately **not** clamped, because silently
 * correcting money arithmetic hides the defect and posts a number nobody computed.
 */
export function computeRefundSplit(input: {
  paymentId: string;
  captured: CapturedLegs;
  /** `P` — already refunded and posted, before this refund. */
  alreadyRefunded: Money;
  /** `r` — the amount being refunded now. */
  amount: Money;
}): RefundSplit {
  const { captured, alreadyRefunded, amount } = input;
  const currency = captured.gross.currency;

  amount.assertSameCurrency(captured.gross);
  alreadyRefunded.assertSameCurrency(captured.gross);

  if (!amount.isPositive) {
    throw PaymentErrors.validation('A refund amount must be a positive integer (minor units).', {
      field: 'amount',
      value: amount.amountMinor,
    });
  }
  if (alreadyRefunded.isNegative) {
    throw PaymentErrors.validation('The already-refunded total must not be negative.', {
      field: 'alreadyRefunded',
      value: alreadyRefunded.amountMinor,
    });
  }

  const cumulativeAfter = alreadyRefunded.add(amount);
  if (cumulativeAfter.isGreaterThan(captured.gross)) {
    // Belt and braces: `RefundPolicy` has already enforced BRULE-24 against the refunded total,
    // which is the same bound. Reaching this means the two disagree.
    throw PaymentErrors.refundExceedsCaptured({
      paymentId: input.paymentId,
      requested: amount.amountMinor,
      captured: captured.gross.amountMinor,
      alreadyRefunded: alreadyRefunded.amountMinor,
      remaining: captured.gross.subtract(alreadyRefunded).amountMinor,
      currency: currency.code,
    });
  }

  const gross = captured.gross.amountMinor;
  const feeClawback = allocateProportionally(captured.fee, cumulativeAfter.amountMinor, gross)
    .subtract(allocateProportionally(captured.fee, alreadyRefunded.amountMinor, gross));
  const promotionClawback = allocateProportionally(
    captured.promotionExpense,
    cumulativeAfter.amountMinor,
    gross,
  ).subtract(
    allocateProportionally(captured.promotionExpense, alreadyRefunded.amountMinor, gross),
  );

  // The tripwire. Never clamped — see the doc above. `feeClawback <= amount` holds for every
  // `F <= G`, which a balanced capture guarantees (the discount clamp keeps `grandTotal >= fee`),
  // and `promotionClawback <= E` holds for the same telescoping reason. A violation means the
  // inputs are not a capture allocation at all.
  if (feeClawback.isNegative || feeClawback.isGreaterThan(amount)) {
    throw PaymentErrors.ledgerUnbalanced({
      debit: feeClawback.amountMinor,
      credit: amount.amountMinor,
      currency: currency.code,
    });
  }
  if (promotionClawback.isNegative || promotionClawback.isGreaterThan(captured.promotionExpense)) {
    throw PaymentErrors.ledgerUnbalanced({
      debit: promotionClawback.amountMinor,
      credit: captured.promotionExpense.amountMinor,
      currency: currency.code,
    });
  }

  // The remainder, so debits (`provider + fee`) always equal credits (`amount + promotion`).
  const providerClawback = amount.add(promotionClawback).subtract(feeClawback);

  return { amount, feeClawback, promotionClawback, providerClawback };
}

/**
 * §11.4's refund accounting: *"LedgerService.post(REFUND) (reverse provider-payable/revenue
 * proportionally)"*.
 *
 * ## The split is read from the ledger, not recomputed
 *
 * The capture's fee split is already a committed fact: `CAPTURE-<paymentId>` records exactly what
 * was credited to `PROVIDER_PAYABLE` and to `PLATFORM_REVENUE`, and which pharmacy owns the
 * payable. This service reads those legs back rather than re-deriving them from `Order.platformFee`.
 *
 * That is not defensiveness for its own sake. A fee re-derived at refund time could differ from the
 * one actually posted at capture — the configured rate may have changed, or the order may have been
 * amended — and a reversal that does not match its original posting leaves both accounts wrong in
 * opposite directions. Reversing what was posted is the only way the two can never disagree. It
 * also means the refund automatically credits the *same* pharmacy the capture credited, without any
 * caller supplying a pharmacy id.
 *
 * ## The postings
 *
 * Both destinations debit the same two accounts — the money is being taken back from whoever
 * received it — and differ only in where it goes:
 *
 * ```
 * destination = ORIGINAL                     destination = WALLET
 *   DEBIT  Provider-Payable  (clawback)        DEBIT  Provider-Payable  (clawback)
 *   DEBIT  Platform-Revenue  (fee clawback)    DEBIT  Platform-Revenue  (fee clawback)
 *   CREDIT Promotion-Expense (promo clawback)  CREDIT Promotion-Expense (promo clawback)
 *   CREDIT Gateway-Clearing  (amount)          CREDIT Customer-Wallet   (amount)
 * ```
 *
 * The promotion leg is the mirror of the capture's `PROMOTION_EXPENSE` debit (ADR-019): a refunded
 * order is one the platform no longer subsidised, so its share of the discount is given back to
 * the expense account. It is omitted entirely for a capture that posted no promotion leg, which is
 * every capture with no coupon — so refunds of un-discounted payments are byte-for-byte what they
 * were before ADR-019 was resolved.
 *
 * `ORIGINAL` credits `GATEWAY_CLEARING` because that is the account the capture debited when the
 * money came in through the gateway; sending it back out is the exact mirror. `REFUNDS_PAYABLE`
 * exists in §7's chart of accounts but is deliberately **not** used: it would model a refund that
 * is *owed but not yet paid*, and this flow only posts after the gateway has confirmed the money is
 * on its way, so there is no liability period to represent. Introducing one would be inventing a
 * settlement stage the design never describes.
 *
 * `WALLET` credits the customer's `CUSTOMER_WALLET` account (§11.4 — "WALLET → LedgerService credit
 * wallet"). No wallet table, no mutable balance column, nothing beyond this posting: §3.3 F-WAL-01
 * says a wallet balance is *derived from the ledger*, and `LedgerService.balanceOf` already derives
 * it. See `RefundPaymentCommand` for what the Wallet feature still owes beyond this credit.
 *
 * Every posting goes through `LedgerService`; nothing here writes ledger rows directly, and nothing
 * touches `account_balances` (the repository refreshes that cache itself).
 */
@Injectable()
export class RefundAccountingService {
  constructor(
    private readonly ledger: LedgerService,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRepository: ILedgerRepository,
    @Inject(REFUND_REPOSITORY) private readonly refunds: IRefundRepository,
  ) {}

  /**
   * Posts §11.4's balanced refund transaction inside the caller's transaction.
   *
   * A zero-value leg is omitted rather than posted — the ledger rejects zero entries, and a zero
   * fee clawback simply means the whole refund comes out of the provider's payable.
   */
  async post(
    payment: PaymentProps,
    refund: RefundProps,
    tx: unknown,
  ): Promise<RefundPosting> {
    const captured = await this.readCapturedLegs(payment, tx);
    const amount = Money.of(refund.amount, payment.currency);

    // `P` — refunds that have already **posted**, which is exactly the `COMPLETED` ones: a refund
    // posts and is marked `COMPLETED` inside one transaction, and the refund being posted here is
    // still `PENDING` at this point, so it is correctly excluded from its own baseline. A `PENDING`
    // refund from an ambiguous provider outcome has moved no money and posted no clawback, so it
    // must not shift the baseline either (see `IRefundRepository`).
    const alreadyRefunded = Money.of(
      await this.refunds.totalCompletedRefundedForPayment(payment.id, tx),
      payment.currency,
    );

    const split = computeRefundSplit({
      paymentId: payment.id,
      captured,
      alreadyRefunded,
      amount,
    });

    const accounts = await this.resolveAccounts(payment, captured, split, refund, tx);
    const reference = refundLedgerReference(refund.id);

    // A zero-value leg is omitted rather than posted — the ledger rejects zero entries. The two
    // debits always sum to `split.amount + split.promotionClawback` (the provider leg is the
    // remainder), so the posting balances against the credits whatever the rounding did.
    const entries: LedgerEntryDraftInput[] = [
      ...(split.providerClawback.isPositive && accounts.payable
        ? [
            {
              accountId: accounts.payable,
              direction: LedgerDirection.DEBIT,
              amount: split.providerClawback,
            },
          ]
        : []),
      ...(split.feeClawback.isPositive && accounts.revenue
        ? [
            {
              accountId: accounts.revenue,
              direction: LedgerDirection.DEBIT,
              amount: split.feeClawback,
            },
          ]
        : []),
      ...(split.promotionClawback.isPositive && accounts.promotion
        ? [
            {
              accountId: accounts.promotion,
              direction: LedgerDirection.CREDIT,
              amount: split.promotionClawback,
            },
          ]
        : []),
      { accountId: accounts.destination, direction: LedgerDirection.CREDIT, amount: split.amount },
    ];

    const posted = await this.ledger.post(
      {
        reference,
        type: LedgerTransactionType.REFUND,
        // Keyed to the refund, not the payment: §7's `refunds` is the entity being recorded, and a
        // payment with several partial refunds must produce several distinguishable postings.
        refType: 'refund',
        refId: refund.id,
        description: `Refund ${refund.type} for order ${payment.orderId}`,
        entries,
      },
      tx,
    );

    return { reference, split, posted };
  }

  /**
   * Reads the capture posting this refund reverses and projects its legs.
   *
   * A payment recorded as captured with no `CAPTURE-<paymentId>` posting behind it is a defect, not
   * a caller error — and the only alternative to refusing would be to invent which accounts the
   * money came from, which is exactly what this service exists to avoid.
   */
  private async readCapturedLegs(payment: PaymentProps, tx?: unknown): Promise<CapturedLegs> {
    const reference = captureLedgerReference(payment.id);
    const header = await this.ledgerRepository.findTransactionByReference(reference, tx);
    if (!header) {
      throw PaymentErrors.capturePostingMissing(payment.id, reference);
    }

    const entries = await this.ledgerRepository.findEntriesByTransactionId(header.id, tx);
    const currency = payment.currency;
    let providerNet = Money.zero(currency);
    let fee = Money.zero(currency);
    let gross = Money.zero(currency);
    let promotionExpense = Money.zero(currency);
    let pharmacyId: string | null = null;

    for (const entry of entries) {
      const account = await this.ledgerRepository.findAccountById(entry.accountId, tx);
      if (!account) {
        continue;
      }
      const value = Money.of(entry.amount, entry.currency);
      if (
        account.type === LedgerAccountType.PROVIDER_PAYABLE &&
        entry.direction === LedgerDirection.CREDIT
      ) {
        providerNet = providerNet.add(value);
        pharmacyId = account.ownerId;
      } else if (
        account.type === LedgerAccountType.PLATFORM_REVENUE &&
        entry.direction === LedgerDirection.CREDIT
      ) {
        fee = fee.add(value);
      } else if (
        account.type === LedgerAccountType.GATEWAY_CLEARING &&
        entry.direction === LedgerDirection.DEBIT
      ) {
        gross = gross.add(value);
      } else if (
        account.type === LedgerAccountType.PROMOTION_EXPENSE &&
        entry.direction === LedgerDirection.DEBIT
      ) {
        // ADR-019's platform-funded discount, read back like every other leg rather than
        // re-derived from `Order.discountTotal`. A capture posted before ADR-019, or one for an
        // order with no coupon, simply has no such entry and leaves this zero.
        promotionExpense = promotionExpense.add(value);
      }
    }

    if (providerNet.isPositive && pharmacyId === null) {
      // A capture that credited a payable must name its owner (§11.3). Its absence means the
      // posting is not the shape this reversal understands. A capture whose fee equalled the gross
      // credits no payable at all, and that is fine — there is nothing to claw back from one.
      throw PaymentErrors.capturePostingMissing(payment.id, reference);
    }
    if (!providerNet.add(fee).equals(gross.add(promotionExpense))) {
      // The capture posting balanced when it was written, so its credit legs must sum to its debit
      // legs. If they do not, the posting is not a capture this service can safely reverse. With
      // no promotion leg this is the original `providerNet + fee === gross`.
      throw PaymentErrors.ledgerUnbalanced({
        debit: gross.add(promotionExpense).amountMinor,
        credit: providerNet.add(fee).amountMinor,
        currency,
      });
    }

    return { gross, providerNet, fee, promotionExpense, pharmacyId };
  }

  /**
   * Accounts by natural key, never by hard-coded id (§7's chart of accounts).
   *
   * Only the accounts the posting will actually debit or credit are resolved. Resolving opens an
   * account on first use, so eagerly resolving a payable for a refund with no payable clawback
   * would create an empty `PROVIDER_PAYABLE` row that nothing ever posts to.
   */
  private async resolveAccounts(
    payment: PaymentProps,
    captured: CapturedLegs,
    split: RefundSplit,
    refund: RefundProps,
    tx?: unknown,
  ): Promise<{
    payable: string | null;
    revenue: string | null;
    promotion: string | null;
    destination: string;
  }> {
    const currency = payment.currency;
    const destinationRef =
      refund.destination === RefundDestination.WALLET
        ? // The wallet is the *customer's*, taken from the payment — never from a request field, so
          // no caller can redirect a refund into someone else's wallet.
          AccountRef.customerWallet(payment.customerUserId, currency)
        : AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, currency);

    const [payable, revenue, promotion, destination] = await Promise.all([
      split.providerClawback.isPositive && captured.pharmacyId
        ? this.ledger.resolveAccount(
            AccountRef.providerPayable(captured.pharmacyId, currency),
            tx,
          )
        : Promise.resolve(null),
      split.feeClawback.isPositive
        ? this.ledger.resolveAccount(
            AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE, currency),
            tx,
          )
        : Promise.resolve(null),
      // Resolved only when it will be credited. The capture already opened this account if it
      // debited one, so this is a lookup rather than a creation in every reachable case.
      split.promotionClawback.isPositive
        ? this.ledger.resolveAccount(
            AccountRef.platform(LedgerAccountType.PROMOTION_EXPENSE, currency),
            tx,
          )
        : Promise.resolve(null),
      this.ledger.resolveAccount(destinationRef, tx),
    ]);

    if (split.providerClawback.isPositive && !payable) {
      // Unreachable via `readCapturedLegs`, which already refuses a payable-crediting capture with
      // no owner. Asserted rather than assumed: the alternative is a silently dropped debit leg,
      // which would unbalance the posting.
      throw PaymentErrors.capturePostingMissing(payment.id, captureLedgerReference(payment.id));
    }

    return {
      payable: payable?.id ?? null,
      revenue: revenue?.id ?? null,
      promotion: promotion?.id ?? null,
      destination: destination.id,
    };
  }
}
