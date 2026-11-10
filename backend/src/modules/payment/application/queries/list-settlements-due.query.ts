import { Inject, Injectable } from '@nestjs/common';
import { LedgerAccountType } from '../../domain/enums';
import { ILedgerRepository, LEDGER_REPOSITORY } from '../../domain/repositories/ledger.repository';
import { ISettlementRepository, SETTLEMENT_REPOSITORY } from '../../domain/repositories/settlement.repository';
import { SettlementPeriod } from '../../domain/value-objects/settlement-period.vo';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { ProviderPayableService } from '../services/provider-payable.service';
import { dueTrigger, FIRST_SETTLEMENT_PERIOD_START, SettlementAutoRunService } from '../services/settlement-auto-run.service';

export interface SettlementDue {
  pharmacyId: string;
  /** The pharmacy's storefront name, when Module 04 has one. */
  pharmacyName: string | null;
  currency: string;
  /** The period a statement run now would cover: from the last statement's end (or the start) to now. */
  periodStart: Date;
  periodEnd: Date;
  netPayable: number;
  lineCount: number;
  /** The earliest unsettled posting in that period. */
  oldestLineAt: Date | null;
  lastStatement: { settlementId: string; periodEnd: Date; status: string } | null;
  /** What the automatic run (Work 97) would say: `AMOUNT`, `PERIOD`, or `null` when it would wait. */
  autoRunTrigger: string | null;
}

/**
 * Work 124: what a finance officer can settle now (`GET /admin/finance/settlements/due`). For each
 * pharmacy payable account with something unsettled since its last statement: the period a run
 * would cover, the net payable and lines it would carry, and whether the automatic run would
 * already generate it. Read-only; the same derivation `RunSettlementCommand` and the automatic run
 * use, so the figure shown is the figure a run produces. Running one stays `POST …/settlements/run`.
 */
@Injectable()
export class ListSettlementsDueQuery {
  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledger: ILedgerRepository,
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    private readonly payable: ProviderPayableService,
    private readonly autoRun: SettlementAutoRunService,
  ) {}

  async execute(now = new Date()): Promise<{ items: SettlementDue[]; checkedAt: Date }> {
    const { minAmount, periodDays } = this.autoRun.settings();
    const accounts = await this.ledger.listAccountsByType(LedgerAccountType.PROVIDER_PAYABLE);
    const due: Array<Omit<SettlementDue, 'pharmacyName'>> = [];
    for (const account of accounts) {
      if (!account.ownerId) continue;
      const last = await this.settlements.findLatestFor(account.ownerId, account.currency);
      const periodStart = last?.periodEnd ?? FIRST_SETTLEMENT_PERIOD_START;
      if (periodStart.getTime() >= now.getTime()) continue;
      const derived = await this.payable.derive(account.ownerId, account.currency, SettlementPeriod.of(periodStart, now));
      if (derived.lines.length === 0) continue;
      const oldestLineAt = derived.lines.reduce<Date | null>((min, l) => (!min || l.occurredAt < min ? l.occurredAt : min), null);
      due.push({
        pharmacyId: account.ownerId,
        currency: account.currency,
        periodStart,
        periodEnd: now,
        netPayable: derived.totals.netPayable,
        lineCount: derived.lines.length,
        oldestLineAt,
        lastStatement: last ? { settlementId: last.id, periodEnd: last.periodEnd, status: last.status } : null,
        autoRunTrigger:
          minAmount === 0 && periodDays === 0
            ? null
            : dueTrigger({ netPayable: derived.totals.netPayable, since: last?.periodEnd ?? oldestLineAt ?? now, now, minAmount, periodDays }),
      });
    }
    const names = (await this.pharmacies.findDisplayNames?.(due.map((d) => d.pharmacyId))) ?? new Map<string, string>();
    return {
      items: due
        .map((d) => ({ ...d, pharmacyName: names.get(d.pharmacyId) ?? null }))
        .sort((a, b) => b.netPayable - a.netPayable),
      checkedAt: now,
    };
  }
}
