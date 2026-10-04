import { Inject, Injectable } from '@nestjs/common';
import { LedgerAccountType } from '../../domain/enums';
import {
  ILedgerRepository,
  LEDGER_REPOSITORY,
} from '../../domain/repositories/ledger.repository';
import {
  ClassifiedLeg,
  SettleableTransaction,
  SettlementCalculator,
  SettlementLineDraft,
  SettlementTotals,
} from '../../domain/services/settlement-calculator';
import { AccountRef } from '../../domain/value-objects/account-ref.vo';
import { SettlementPeriod } from '../../domain/value-objects/settlement-period.vo';

/** Everything a statement needs, derived from the ledger and nothing else. */
export interface DerivedPayable {
  pharmacyId: string;
  currency: string;
  period: SettlementPeriod;
  lines: SettlementLineDraft[];
  totals: SettlementTotals;
}

/**
 * Derives what a provider is owed **from the immutable ledger** (F-STL-01, BRULE-23).
 *
 * ## The formula, in full
 *
 * ```
 * A                    = PROVIDER_PAYABLE(pharmacyId, currency)          the provider's account
 * E                    = A's entries with createdAt in [periodStart, periodEnd)
 * T                    = the distinct postings those entries belong to
 * for each t in T:
 *   providerPayable(t) = Σ credits(t, A)      − Σ debits(t, A)
 *   platformRevenue(t) = Σ credits(t, REVENUE)− Σ debits(t, REVENUE)
 *   promotionExp(t)    = Σ debits(t, PROMO)   − Σ credits(t, PROMO)
 *   customerCash(t)    = Σ debits(t, GATEWAY) − Σ credits(t, GATEWAY)
 * netPayable           = Σ providerPayable(t)
 * ```
 *
 * `netPayable` is a function of the payable legs and of nothing else. Platform revenue and
 * promotion expense are read from the same postings and reported, but they never enter it.
 *
 * ## Why the whole posting is loaded, not just the provider's legs
 *
 * The provider's own entries alone would give the payable and nothing more. Platform revenue and
 * promotion expense live on **platform-level accounts** shared by every pharmacy, so their
 * balances cannot be split per provider — the only honest attribution is "the revenue and expense
 * legs of the postings that moved *this* provider's payable". That is what makes a statement
 * reproducible: each line names a `ledger_transactions.reference`, and re-reading that posting
 * reproduces all four figures exactly.
 *
 * ## What it does not do
 *
 * It does not read `account_balances` — that is a rebuildable cache and never authoritative
 * (ADR-006). It does not read an order, a payment, a coupon or any configuration: no order total,
 * platform fee or coupon discount is ever re-computed at settlement time. And it writes nothing.
 */
@Injectable()
export class ProviderPayableService {
  constructor(@Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository) {}

  async derive(
    pharmacyId: string,
    currency: string,
    period: SettlementPeriod,
    tx?: unknown,
  ): Promise<DerivedPayable> {
    const account = await this.ledger.findAccountByRef(
      AccountRef.providerPayable(pharmacyId, currency).toKey(),
      tx,
    );

    // No account means no capture ever credited this provider. That is an empty statement, not an
    // error: a pharmacy with no orders in a period is a normal thing to settle, and refusing would
    // make a scheduled run fail on its quietest providers.
    if (!account) {
      return this.empty(pharmacyId, currency, period);
    }

    const entries = await this.ledger.findEntriesByAccountInPeriod(
      account.id,
      { from: period.start, to: period.end },
      tx,
    );
    if (entries.length === 0) {
      return this.empty(pharmacyId, currency, period);
    }

    // Distinct postings, in the order their first entry appeared — so a statement reads
    // chronologically without a second sort over data the ledger already ordered.
    const transactionIds: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!seen.has(entry.transactionId)) {
        seen.add(entry.transactionId);
        transactionIds.push(entry.transactionId);
      }
    }

    const lines: SettlementLineDraft[] = [];
    for (const transactionId of transactionIds) {
      const settleable = await this.loadTransaction(transactionId, tx);
      if (settleable) {
        lines.push(SettlementCalculator.lineFor(settleable, pharmacyId, currency));
      }
    }

    return {
      pharmacyId,
      currency,
      period,
      lines,
      totals: SettlementCalculator.totals(lines),
    };
  }

  /**
   * Loads one posting with every leg classified by account type.
   *
   * Account lookups are memoized per call: a period of captures touches the same three or four
   * platform accounts over and over, and resolving each one per leg would turn a statement into
   * thousands of identical reads.
   */
  private async loadTransaction(
    transactionId: string,
    tx?: unknown,
    cache: Map<string, { type: LedgerAccountType; ownerId: string | null }> = new Map(),
  ): Promise<SettleableTransaction | null> {
    const posted = await this.ledger.findTransactionById(transactionId, tx);
    if (!posted) {
      // Unreachable while the ledger is append-only — an entry cannot outlive its header. Skipped
      // rather than thrown: reconciliation's job is to report an anomaly like this, and a
      // scheduled settlement run should not be the thing that dies of it.
      return null;
    }

    const legs: ClassifiedLeg[] = [];
    for (const entry of posted.entries) {
      let account = cache.get(entry.accountId);
      if (!account) {
        const resolved = await this.ledger.findAccountById(entry.accountId, tx);
        if (!resolved) {
          continue;
        }
        account = { type: resolved.type, ownerId: resolved.ownerId };
        cache.set(entry.accountId, account);
      }
      legs.push({
        accountType: account.type,
        ownerId: account.ownerId,
        direction: entry.direction,
        amount: entry.amount,
        currency: entry.currency,
      });
    }

    return {
      transactionId: posted.transaction.id,
      reference: posted.transaction.reference,
      type: posted.transaction.type,
      refType: posted.transaction.refType,
      refId: posted.transaction.refId,
      occurredAt: posted.transaction.createdAt,
      legs,
    };
  }

  private empty(
    pharmacyId: string,
    currency: string,
    period: SettlementPeriod,
  ): DerivedPayable {
    return {
      pharmacyId,
      currency,
      period,
      lines: [],
      totals: SettlementCalculator.totals([]),
    };
  }
}
