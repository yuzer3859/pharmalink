import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { LedgerDirection } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { walletDebitedEvent } from '../../domain/events';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import { BASE_CURRENCY } from '../../domain/value-objects/currency.vo';
import { IdempotencyKey } from '../../domain/value-objects/idempotency-key.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import {
  WalletAccountingService,
  walletSpendReference,
} from '../services/wallet-accounting.service';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';

export interface SpendWalletInput {
  /**
   * Whose wallet is being spent. Comes from the calling saga's own authenticated context — the
   * order's `customerUserId` — never from a client. There is no HTTP route that reaches this.
   */
  customerUserId: string;
  /** The order the spend pays for. Also the spend's idempotency identity (§11.6). */
  orderId: string;
  amount: number;
  currency?: string;
  /** REQUIRED replay key (BRULE-25, §5.3). */
  idempotencyKey: string;
  actorUserId?: string | null;
}

export interface SpendWalletResult {
  customerUserId: string;
  orderId: string;
  amount: number;
  currency: string;
  /** The `ledger_transactions.reference` of the spend posting. */
  ledgerReference: string;
  /** Derived inside the posting transaction, as `Σ credits − Σ debits`. Never negative. */
  balance: number;
  /** `true` when an already-committed spend was returned rather than a new one performed. */
  replay: boolean;
}

/**
 * §11.6's wallet spend — `DEBIT Customer-Wallet`, `CREDIT Gateway-Clearing`.
 *
 * **Internal only.** §9.4 says "wallet spend is internal, invoked by the checkout saga", and this
 * module exposes no HTTP route that reaches it. Module 06 will call it in-process through
 * `IWalletPort`; wiring that into checkout is a separate task and Module 06 is untouched here.
 *
 * ## Sufficiency and concurrency are the same problem
 *
 * A wallet must never go negative, and the only way to guarantee that is to make "read the balance"
 * and "write the debit" one atomic act. Both happen inside a single `Serializable` transaction in
 * `WalletAccountingService.postSpend`: PostgreSQL's SSI detects that two concurrent spends each
 * summed the range the other wrote into and aborts one, `runWithPaymentRetry` re-runs the loser
 * from the top, and the loser then reads the winner's debit and correctly refuses with
 * `INSUFFICIENT_WALLET_BALANCE`. The retry is safe because this transaction contains no external
 * side effect — there is no gateway in a wallet spend at all.
 *
 * No application mutex, no advisory lock, no in-process queue: those would be a second concurrency
 * boundary that only holds within one process, and the database is the real one.
 *
 * ## Idempotency
 *
 * The identity of a spend is its **order**: `WALLET-SPEND-<orderId>` is `@unique` in
 * `ledger_transactions`, so an order can be paid from the wallet at most once, however many times
 * a saga retries. A replay returns the committed posting; a retry that names the same order with a
 * *different* amount is an `IDEMPOTENCY_CONFLICT`, not a silent substitution, because the request
 * is materially different from the one that was committed. This is the same mechanism capture,
 * refund and top-up use rather than a second one racing them; the caller's `idempotencyKey` is
 * required and validated on the way in, and recorded in the audit entry.
 */
@Injectable()
export class SpendWalletCommand {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly wallets: WalletAccountingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: SpendWalletInput): Promise<SpendWalletResult> {
    const customerUserId = requireText(input.customerUserId, 'customerUserId');
    const orderId = requireText(input.orderId, 'orderId');
    const idempotencyKey = IdempotencyKey.of(input.idempotencyKey).value;
    const currency = input.currency ?? BASE_CURRENCY;
    const amount = Money.of(input.amount, currency);
    if (!amount.isPositive) {
      throw PaymentErrors.validation('A wallet spend must be a positive amount.', {
        field: 'amount',
        value: input.amount,
      });
    }

    const reference = walletSpendReference(orderId);

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        const existing = await this.ledger.findTransactionByReference(reference, tx);
        if (existing) {
          return this.replayOf(existing.id, customerUserId, orderId, amount, reference, tx);
        }

        // Balance check and debit, atomically. See the class doc.
        const posting = await this.wallets.postSpend({ customerUserId, orderId, amount }, tx);

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? customerUserId,
            action: 'WALLET_SPENT',
            resourceType: 'Wallet',
            resourceId: customerUserId,
            context: {
              customerUserId,
              orderId,
              amount: amount.amountMinor,
              currency: amount.currency.code,
              ledgerReference: posting.reference,
              balanceAfter: posting.balanceAfter.amountMinor,
              idempotencyKey,
              outcome: 'DEBITED',
            },
          },
          tx,
        );

        await this.outbox.write(
          walletDebitedEvent({ userId: customerUserId, amount: amount.amountMinor }),
          tx as OutboxCapableClient,
        );

        return {
          customerUserId,
          orderId,
          amount: amount.amountMinor,
          currency: amount.currency.code,
          ledgerReference: posting.reference,
          balance: posting.balanceAfter.amountMinor,
          replay: false,
        };
      });
    } catch (err) {
      // Two concurrent spends of the same order raced the unique reference. The loser returns the
      // winner's committed posting rather than debiting the wallet twice.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.ledger.findTransactionByReference(reference);
        if (winner) {
          return this.replayOf(winner.id, customerUserId, orderId, amount, reference);
        }
      }
      throw err;
    }
  }

  /**
   * Interprets a spend already committed for this order.
   *
   * The committed debit's own amount is what the reference means; a caller asking for a different
   * amount under it is describing a different operation and gets `IDEMPOTENCY_CONFLICT` rather
   * than the original result. The wallet's balance is re-derived rather than remembered.
   */
  private async replayOf(
    transactionId: string,
    customerUserId: string,
    orderId: string,
    requested: Money,
    reference: string,
    tx?: unknown,
  ): Promise<SpendWalletResult> {
    const wallet = await this.wallets.resolveWalletAccount(
      customerUserId,
      requested.currency.code,
      tx,
    );
    const entries = await this.ledger.findEntriesByTransactionId(transactionId, tx);
    const debit = entries.find(
      (entry) => entry.accountId === wallet.id && entry.direction === LedgerDirection.DEBIT,
    );
    if (!debit) {
      // The reference exists but debits a different customer's wallet — two orders can never
      // share an id, so this is a defect or a tampered row, not a caller error to smooth over.
      throw PaymentErrors.idempotencyConflict({ orderId, reference });
    }
    if (debit.amount !== requested.amountMinor) {
      throw PaymentErrors.idempotencyConflict({
        orderId,
        reference,
        committed: debit.amount,
        requested: requested.amountMinor,
      });
    }

    const balance = await this.wallets.balanceOf(customerUserId, requested.currency.code, tx);
    return {
      customerUserId,
      orderId,
      amount: debit.amount,
      currency: debit.currency,
      ledgerReference: reference,
      balance: balance.amountMinor,
      replay: true,
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
