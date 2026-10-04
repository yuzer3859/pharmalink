import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { PaymentProps } from '../../domain/entities/payment.entity';
import { PaymentStatus } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { walletCreditedEvent } from '../../domain/events';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import { IdempotencyKey } from '../../domain/value-objects/idempotency-key.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { captureLedgerReference } from '../services/capture-accounting.service';
import {
  WalletAccountingService,
  walletTopUpReference,
} from '../services/wallet-accounting.service';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';

export interface TopUpWalletInput {
  /** Resolved from the authenticated principal by the caller — never from a request body. */
  customerUserId: string;
  /** The captured payment that funds this top-up. Its amount is what gets credited. */
  paymentId: string;
  /**
   * Asserted by the caller and checked against the funding payment's own amount; **never** used
   * as the credited figure. What reaches the wallet is always what the payment actually collected.
   */
  amount?: number | null;
  /** REQUIRED replay key (BRULE-25, §5.3). */
  idempotencyKey: string;
  /** The acting user, for the audit trail (§13). Usually the customer themselves. */
  actorUserId?: string | null;
}

export interface TopUpWalletResult {
  customerUserId: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** The `ledger_transactions.reference` of the top-up posting. */
  ledgerReference: string;
  /** Derived inside the posting transaction, as `Σ credits − Σ debits`. */
  balance: number;
  /** `true` when an already-committed top-up was returned rather than a new one performed. */
  replay: boolean;
}

/**
 * §3.3 F-WAL-02's "top-up (via payment)" — the wallet half of it.
 *
 * ## Money is never created here
 *
 * This command does not authorize anything, does not select a provider, does not call a gateway
 * and does not capture. It **consumes** a payment that already collected real money and moves that
 * money into the customer's wallet. Every one of those steps already exists in this module and is
 * not duplicated: provider selection lives in `PaymentProviderRegistry`, authorization in
 * `AuthorizePaymentCommand`, capture in `CapturePaymentCommand`, provider idempotency in the
 * adapters. A second payment operation inside Wallet would be a second thing that can charge a
 * customer.
 *
 * Three conditions must hold before a santim is credited, and each rules out a distinct way of
 * inventing money:
 *
 *  1. **The payment is `CAPTURED`.** An authorization is a hold, not money — crediting a wallet
 *     from one would hand out funds that may never arrive.
 *  2. **The payment belongs to this customer.** Otherwise a top-up could launder one customer's
 *     payment into another's wallet.
 *  3. **The payment's funds are not already allocated.** A `CAPTURE-<paymentId>` posting means
 *     `CaptureAccountingService` already routed that gross to a pharmacy's `PROVIDER_PAYABLE` and
 *     the platform's revenue; crediting the wallet as well would pay the same money out twice.
 *     This is the check that makes the command safe rather than merely careful.
 *
 * The credited amount is read off the payment, never off the input. `input.amount`, if given, is
 * an assertion that is verified and rejected on mismatch — the same discipline
 * `AuthorizePaymentCommand` applies to the amount a client claims it is paying.
 *
 * ## Idempotency
 *
 * The identity of a top-up is its funding **payment**, not a caller-supplied string:
 * `WALLET-TOPUP-<paymentId>` is `@unique` in `ledger_transactions`, so one payment can credit a
 * wallet at most once however many retries or concurrent callers try. That is the same mechanism
 * capture and refund use (`CAPTURE-<paymentId>`, `REFUND-<refundId>`) rather than a second,
 * weaker one racing them. The caller's `idempotencyKey` is required and validated on the way in —
 * §5.3 requires every money op to carry one — and is recorded in the audit entry; it cannot serve
 * as the identity because a key naming a *different* payment describes a different operation.
 *
 * ## What this command cannot do yet
 *
 * It cannot originate the funding payment. `payments.orderId` is `NOT NULL` and
 * `AuthorizePaymentCommand` validates the amount against a real Module 06 order, so this module
 * has no order-less payment path a top-up could use — and building one means changing
 * money-critical payment code and the payments schema, which is not this task. Consequently
 * §9.4's `POST /wallet/topup` route is deliberately **not** exposed: a route whose flow cannot be
 * completed is not an API. The wallet half is finished, tested, and ready for that path to arrive.
 */
@Injectable()
export class TopUpWalletCommand {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly wallets: WalletAccountingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: TopUpWalletInput): Promise<TopUpWalletResult> {
    const customerUserId = requireText(input.customerUserId, 'customerUserId');
    const paymentId = requireText(input.paymentId, 'paymentId');
    // Validated even though the reference is the identity: §5.3 requires every money op to carry
    // a well-formed key, and a malformed one should fail before any money is considered.
    const idempotencyKey = IdempotencyKey.of(input.idempotencyKey).value;

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        const payment = await this.payments.findById(paymentId, tx);
        if (!payment) {
          throw PaymentErrors.notFound('Payment not found.', { paymentId });
        }
        this.assertFundsTopUpFor(payment, customerUserId, input.amount ?? null);

        const reference = walletTopUpReference(paymentId);
        const existing = await this.ledger.findTransactionByReference(reference, tx);
        if (existing) {
          // Already credited. Return the committed result rather than posting again (BRULE-25).
          return this.buildResult(payment, reference, true, tx);
        }

        // The `CAPTURE-<paymentId>` guard is read inside this transaction, so a capture racing
        // this top-up cannot slip between the check and the posting.
        await this.assertFundsUnallocated(payment, tx);

        const amount = Money.of(payment.amount, payment.currency);
        const posting = await this.wallets.postTopUp({ customerUserId, paymentId, amount }, tx);

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? customerUserId,
            action: 'WALLET_TOPPED_UP',
            resourceType: 'Wallet',
            resourceId: customerUserId,
            context: {
              customerUserId,
              paymentId,
              amount: amount.amountMinor,
              currency: amount.currency.code,
              ledgerReference: posting.reference,
              balanceAfter: posting.balanceAfter.amountMinor,
              idempotencyKey,
              outcome: 'CREDITED',
              // No provider token, provider reference, credential or raw payload — §13. The
              // ledger posting itself remains the financial audit trail.
            },
          },
          tx,
        );

        await this.outbox.write(
          walletCreditedEvent({ userId: customerUserId, amount: amount.amountMinor }),
          tx as OutboxCapableClient,
        );

        return {
          customerUserId,
          paymentId,
          amount: amount.amountMinor,
          currency: amount.currency.code,
          ledgerReference: posting.reference,
          balance: posting.balanceAfter.amountMinor,
          replay: false,
        };
      });
    } catch (err) {
      // A concurrent top-up of the same payment lost the race on the unique reference. The loser
      // returns the winner's committed posting rather than crediting the wallet twice.
      if (isUniqueConstraintViolation(err)) {
        const payment = await this.payments.findById(paymentId);
        if (payment) {
          return this.buildResult(payment, walletTopUpReference(paymentId), true);
        }
      }
      throw err;
    }
  }

  /** Conditions 1 and 2, plus the caller's optional amount assertion. */
  private assertFundsTopUpFor(
    payment: PaymentProps,
    customerUserId: string,
    assertedAmount: number | null,
  ): void {
    if (payment.customerUserId !== customerUserId) {
      // Same shape as a missing payment, deliberately: a caller must not be able to probe whether
      // someone else's payment exists by trying to top up from it.
      throw PaymentErrors.notFound('Payment not found.', { paymentId: payment.id });
    }
    if (payment.status !== PaymentStatus.CAPTURED) {
      throw PaymentErrors.walletTopUpSourceInvalid(
        'A wallet top-up requires a captured payment.',
        { paymentId: payment.id, status: payment.status },
      );
    }
    if (assertedAmount !== null && assertedAmount !== payment.amount) {
      throw PaymentErrors.validation(
        'The requested amount does not match the funding payment.',
        { field: 'amount', expected: payment.amount, received: assertedAmount },
      );
    }
  }

  /** Condition 3 — the one that keeps the credit backed. */
  private async assertFundsUnallocated(payment: PaymentProps, tx: unknown): Promise<void> {
    const capture = await this.ledger.findTransactionByReference(
      captureLedgerReference(payment.id),
      tx,
    );
    if (capture) {
      throw PaymentErrors.walletTopUpSourceInvalid(
        "This payment's funds were already settled to a provider and cannot also fund a wallet.",
        { paymentId: payment.id, ledgerReference: capture.reference },
      );
    }
  }

  /** The replay answer: the wallet's real state, read back rather than reconstructed. */
  private async buildResult(
    payment: PaymentProps,
    reference: string,
    replay: boolean,
    tx?: unknown,
  ): Promise<TopUpWalletResult> {
    const balance = await this.wallets.balanceOf(
      payment.customerUserId,
      payment.currency,
      tx,
    );
    return {
      customerUserId: payment.customerUserId,
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      ledgerReference: reference,
      balance: balance.amountMinor,
      replay,
    };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
