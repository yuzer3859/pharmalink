import { Inject, Injectable } from '@nestjs/common';
import { captureLedgerReference } from './capture-accounting.service';
import { ProviderPayableService } from './provider-payable.service';
import { LedgerAccountType, LedgerDirection, PaymentStatus } from '../../domain/enums';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import {
  ISettlementRepository,
  SETTLEMENT_REPOSITORY,
} from '../../domain/repositories/settlement.repository';
import { SettlementPeriod } from '../../domain/value-objects/settlement-period.vo';

/** What kind of discrepancy was found. */
export type AccountingAnomalyKind =
  /** A payment recorded `CAPTURED` with no `CAPTURE-<paymentId>` posting behind it. */
  | 'CAPTURE_POSTING_MISSING'
  /** A capture posting whose legs do not reconcile to `gross + promotion = payable + revenue`. */
  | 'CAPTURE_POSTING_UNBALANCED'
  /** One posting whose debits and credits differ. */
  | 'TRANSACTION_UNBALANCED'
  /** The whole ledger's debits and credits differ, for some currency. */
  | 'LEDGER_IMBALANCE'
  /** A provider-payable posting whose `refType`/`refId` names a payment or refund that is gone. */
  | 'PAYABLE_SOURCE_MISSING'
  /** More than one statement claims the same period for one provider. */
  | 'DUPLICATE_SETTLEMENT'
  /** A stored statement line disagrees with the posting it reports. */
  | 'SETTLEMENT_LINE_MISMATCH'
  /** A statement's totals disagree with the sum of its own lines. */
  | 'SETTLEMENT_TOTAL_MISMATCH';

export interface AccountingAnomaly {
  kind: AccountingAnomalyKind;
  /** Human-readable, safe to log and to put in an admin response. Never contains a secret. */
  message: string;
  /** Whatever identifies the thing at fault — payment id, ledger reference, settlement id. */
  subject: string;
  details?: Record<string, unknown>;
}

/**
 * How many `CAPTURED`/refunded payments one sweep examines when the caller names no limit.
 *
 * Named rather than inlined because a caller has to be able to tell a clean report from a
 * truncated one: a sweep that examined exactly this many payments may well have left others
 * unchecked, and "no anomalies found" would then be a statement about the first 500 rows rather
 * than about the books.
 */
export const DEFAULT_CAPTURED_PAYMENT_LIMIT = 500;

/**
 * How many statements one sweep re-derives. Fixed rather than caller-supplied: re-deriving a
 * statement re-reads its whole period from the ledger, so this is the expensive half of the sweep.
 */
export const SETTLEMENT_SCAN_LIMIT = 200;

export interface ReconciliationReport {
  checkedAt: Date;
  anomalies: AccountingAnomaly[];
  /** Counts of what was examined, so an empty report is distinguishable from an empty database. */
  examined: {
    capturedPayments: number;
    settlements: number;
    settlementLines: number;
    currencies: number;
  };
}

/**
 * `GetReconciliation` (§3.6 F-REC-01, §9.6's `GET /admin/finance/reconciliation`) — the internal,
 * **read-only** accounting reconciliation.
 *
 * ## It reports; it never repairs
 *
 * Nothing here writes. Not a correcting entry, not a status change, not a cached-balance refresh.
 * That is a deliberate boundary, not an unfinished one: every anomaly below means the accounting
 * already disagrees with itself, and an automated fix would be a guess about which side is right,
 * written into an append-only ledger where it can never be withdrawn. A human decides, and the
 * correction is an explicit adjustment posting with an audit trail — a separate task with its own
 * approval rules.
 *
 * It is also distinct from `ReconciliationService`, which recovers *payments stuck in a provider
 * state*. That one is about the gateway; this one is about the books.
 *
 * ## What it deliberately does not check
 *
 * Provider-side reconciliation — our ledger against a gateway's settlement file — is named in
 * F-REC-01 and is **not** here, because no provider contract exists in this repository to compare
 * against. Inventing a file format to parse would be inventing the integration.
 */
@Injectable()
export class AccountingReconciliationService {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
    private readonly payable: ProviderPayableService,
  ) {}

  /**
   * Runs every check and returns what it found. Never throws on a discrepancy — a discrepancy is
   * the output, and an exception would hide the other anomalies behind the first one.
   */
  async run(options: { pharmacyId?: string; limit?: number } = {}): Promise<ReconciliationReport> {
    const anomalies: AccountingAnomaly[] = [];
    const limit = options.limit ?? DEFAULT_CAPTURED_PAYMENT_LIMIT;

    // Every payment whose accounting should already be complete. `findStale` is a plain
    // `status IN (...) AND updatedAt < cutoff` read; a reconciliation sweep wants all of them, not
    // only the ones that have gone quiet, so the cutoff sits slightly ahead of now to include rows
    // touched in this same instant. Partially- and fully-refunded payments are included because
    // they too must have a capture posting behind them — that is what their refunds reversed.
    const captured = await this.payments.findStale({
      statuses: [
        PaymentStatus.CAPTURED,
        PaymentStatus.PARTIALLY_REFUNDED,
        PaymentStatus.REFUNDED,
      ],
      olderThan: new Date(Date.now() + 60_000),
      limit,
    });
    await this.checkCapturePostings(captured, anomalies);
    const currencies = await this.checkLedgerBalance(anomalies);
    const { settlements, lines } = await this.checkSettlements(options.pharmacyId, anomalies);

    return {
      checkedAt: new Date(),
      anomalies,
      examined: {
        capturedPayments: captured.length,
        settlements,
        settlementLines: lines,
        currencies,
      },
    };
  }

  /**
   * Every `CAPTURED` payment must have exactly one balanced capture posting whose legs satisfy
   * ADR-019's invariant.
   *
   * `gross + promotion = payable + revenue` is the identity platform funding introduced: the
   * pharmacy may be credited more than the customer paid, and the promotion expense is what makes
   * up the difference. Checking the plain `gross = payable + revenue` would now produce a false
   * positive on every discounted order.
   */
  private async checkCapturePostings(
    captured: { id: string; amount: number; currency: string }[],
    anomalies: AccountingAnomaly[],
  ): Promise<void> {
    for (const payment of captured) {
      const reference = captureLedgerReference(payment.id);
      const header = await this.ledger.findTransactionByReference(reference);
      if (!header) {
        anomalies.push({
          kind: 'CAPTURE_POSTING_MISSING',
          subject: payment.id,
          message: `Payment ${payment.id} is CAPTURED but has no ${reference} posting.`,
          details: { reference, amount: payment.amount, currency: payment.currency },
        });
        continue;
      }

      const entries = await this.ledger.findEntriesByTransactionId(header.id);
      let gross = 0;
      let payableCredit = 0;
      let revenueCredit = 0;
      let promotionDebit = 0;
      let debits = 0;
      let credits = 0;

      for (const entry of entries) {
        const account = await this.ledger.findAccountById(entry.accountId);
        if (!account) {
          continue;
        }
        const isDebit = entry.direction === LedgerDirection.DEBIT;
        if (isDebit) {
          debits += entry.amount;
        } else {
          credits += entry.amount;
        }
        if (account.type === LedgerAccountType.GATEWAY_CLEARING && isDebit) {
          gross += entry.amount;
        } else if (account.type === LedgerAccountType.PROVIDER_PAYABLE && !isDebit) {
          payableCredit += entry.amount;
        } else if (account.type === LedgerAccountType.PLATFORM_REVENUE && !isDebit) {
          revenueCredit += entry.amount;
        } else if (account.type === LedgerAccountType.PROMOTION_EXPENSE && isDebit) {
          promotionDebit += entry.amount;
        }
      }

      if (debits !== credits) {
        anomalies.push({
          kind: 'TRANSACTION_UNBALANCED',
          subject: reference,
          message: `Posting ${reference} has debits ${debits} and credits ${credits}.`,
          details: { debits, credits },
        });
      }
      if (gross + promotionDebit !== payableCredit + revenueCredit) {
        anomalies.push({
          kind: 'CAPTURE_POSTING_UNBALANCED',
          subject: reference,
          message:
            `Capture ${reference} does not satisfy gross + promotion = payable + revenue ` +
            `(${gross} + ${promotionDebit} != ${payableCredit} + ${revenueCredit}).`,
          details: { gross, promotionDebit, payableCredit, revenueCredit },
        });
      }
      if (header.refType === 'payment' && header.refId !== payment.id) {
        anomalies.push({
          kind: 'PAYABLE_SOURCE_MISSING',
          subject: reference,
          message: `Capture ${reference} names payment ${header.refId}, not ${payment.id}.`,
          details: { refId: header.refId, paymentId: payment.id },
        });
      }
    }
  }

  /** The whole ledger, per currency: Σ debits must equal Σ credits. */
  private async checkLedgerBalance(anomalies: AccountingAnomaly[]): Promise<number> {
    const totals = await this.ledger.sumAllEntriesByCurrency();
    for (const total of totals) {
      if (total.debit !== total.credit) {
        anomalies.push({
          kind: 'LEDGER_IMBALANCE',
          subject: total.currency,
          message:
            `Ledger does not balance in ${total.currency}: debits ${total.debit}, ` +
            `credits ${total.credit}.`,
          details: { debit: total.debit, credit: total.credit },
        });
      }
    }
    return totals.length;
  }

  /**
   * Re-derives every statement from the ledger and compares.
   *
   * This is the check that makes a statement trustworthy: because the ledger is immutable, a
   * statement generated from it must reproduce byte for byte forever. A mismatch means either the
   * statement was written by something other than the current derivation, or rows were altered —
   * both of which a human needs to see before anyone is paid against it.
   */
  private async checkSettlements(
    pharmacyId: string | undefined,
    anomalies: AccountingAnomaly[],
  ): Promise<{ settlements: number; lines: number }> {
    // `undefined` keeps reconciliation unscoped, which is what it must be by default: an anomaly
    // it cannot see is an anomaly nobody is told about.
    const page = await this.settlements.list({
      pharmacyIds: pharmacyId ? [pharmacyId] : undefined,
      page: 1,
      size: SETTLEMENT_SCAN_LIMIT,
    });
    let lineCount = 0;

    for (const settlement of page.items) {
      const overlapping = await this.settlements.findOverlapping(
        settlement.pharmacyId,
        settlement.currency,
        settlement.periodStart,
        settlement.periodEnd,
      );
      const others = overlapping.filter((other) => other.id !== settlement.id);
      if (others.length > 0) {
        anomalies.push({
          kind: 'DUPLICATE_SETTLEMENT',
          subject: settlement.id,
          message:
            `Statement ${settlement.statementRef} overlaps ${others.length} other statement(s) ` +
            `for the same provider and currency; the same postings could be paid twice.`,
          details: { overlapping: others.map((other) => other.id) },
        });
      }

      const lines = await this.settlements.findLines(settlement.id);
      lineCount += lines.length;

      const derived = await this.payable.derive(
        settlement.pharmacyId,
        settlement.currency,
        SettlementPeriod.of(settlement.periodStart, settlement.periodEnd),
      );
      const byTransaction = new Map(
        derived.lines.map((line) => [line.transactionId, line] as const),
      );

      for (const line of lines) {
        const fresh = byTransaction.get(line.ledgerTransactionId);
        if (!fresh) {
          anomalies.push({
            kind: 'SETTLEMENT_LINE_MISMATCH',
            subject: line.ledgerReference,
            message:
              `Statement line ${line.ledgerReference} does not correspond to any ledger posting ` +
              `in the statement's own period.`,
            details: { settlementId: settlement.id, transactionId: line.ledgerTransactionId },
          });
          continue;
        }
        const differs =
          fresh.providerPayableDelta !== line.providerPayableDelta ||
          fresh.platformRevenueDelta !== line.platformRevenueDelta ||
          fresh.promotionExpenseDelta !== line.promotionExpenseDelta ||
          fresh.customerCashDelta !== line.customerCashDelta;
        if (differs) {
          anomalies.push({
            kind: 'SETTLEMENT_LINE_MISMATCH',
            subject: line.ledgerReference,
            message: `Statement line ${line.ledgerReference} no longer matches its ledger posting.`,
            details: {
              settlementId: settlement.id,
              stored: {
                providerPayableDelta: line.providerPayableDelta,
                platformRevenueDelta: line.platformRevenueDelta,
                promotionExpenseDelta: line.promotionExpenseDelta,
                customerCashDelta: line.customerCashDelta,
              },
              derived: {
                providerPayableDelta: fresh.providerPayableDelta,
                platformRevenueDelta: fresh.platformRevenueDelta,
                promotionExpenseDelta: fresh.promotionExpenseDelta,
                customerCashDelta: fresh.customerCashDelta,
              },
            },
          });
        }
      }

      // A statement whose header disagrees with its own lines is internally inconsistent, quite
      // apart from whether either matches the ledger.
      const storedSum = lines.reduce((sum, line) => sum + line.providerPayableDelta, 0);
      if (storedSum !== settlement.netPayable || lines.length !== settlement.lineCount) {
        anomalies.push({
          kind: 'SETTLEMENT_TOTAL_MISMATCH',
          subject: settlement.id,
          message:
            `Statement ${settlement.statementRef} reports net ${settlement.netPayable} over ` +
            `${settlement.lineCount} line(s), but its lines sum to ${storedSum} over ` +
            `${lines.length}.`,
          details: {
            netPayable: settlement.netPayable,
            lineSum: storedSum,
            lineCount: settlement.lineCount,
            actualLines: lines.length,
          },
        });
      }
      if (derived.totals.netPayable !== settlement.netPayable) {
        anomalies.push({
          kind: 'SETTLEMENT_TOTAL_MISMATCH',
          subject: settlement.id,
          message:
            `Statement ${settlement.statementRef} reports net ${settlement.netPayable}, but the ` +
            `ledger now derives ${derived.totals.netPayable} for the same period.`,
          details: {
            stored: settlement.netPayable,
            derived: derived.totals.netPayable,
          },
        });
      }
    }

    return { settlements: page.items.length, lines: lineCount };
  }
}
