import { Inject, Injectable } from '@nestjs/common';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_SETTLEMENT_AUTO_RUN_MIN_AMOUNT,
  DEFAULT_SETTLEMENT_AUTO_RUN_PERIOD_DAYS,
  SETTLEMENT_AUTO_RUN_MIN_AMOUNT_KEY,
  SETTLEMENT_AUTO_RUN_PERIOD_DAYS_KEY,
} from '../../../../shared/config/settlement.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { LedgerAccountType } from '../../domain/enums';
import { ILedgerRepository, LEDGER_REPOSITORY } from '../../domain/repositories/ledger.repository';
import { ISettlementRepository, SETTLEMENT_REPOSITORY } from '../../domain/repositories/settlement.repository';
import { SettlementPeriod } from '../../domain/value-objects/settlement-period.vo';
import { RunSettlementCommand } from '../commands/run-settlement.command';
import { ProviderPayableService } from './provider-payable.service';

/** The start of the first statement for a pharmacy that has never been settled. */
export const FIRST_SETTLEMENT_PERIOD_START = new Date('2020-01-01T00:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

export type AutoRunTrigger = 'AMOUNT' | 'PERIOD';

/**
 * Pure: which trigger, if any, is met (owner's decision 2026-11-07). The amount trigger wins a
 * tie, as it is the more specific reason. `0` switches a trigger off.
 */
export function dueTrigger(input: {
  netPayable: number;
  since: Date;
  now: Date;
  minAmount: number;
  periodDays: number;
}): AutoRunTrigger | null {
  if (!(input.netPayable > 0)) return null;
  if (input.minAmount > 0 && input.netPayable >= input.minAmount) return 'AMOUNT';
  if (input.periodDays > 0 && input.now.getTime() - input.since.getTime() >= input.periodDays * DAY_MS) return 'PERIOD';
  return null;
}

export interface SettlementAutoRunReport {
  examined: number;
  generated: Array<{ pharmacyId: string; currency: string; settlementId: string; trigger: AutoRunTrigger; netPayable: number }>;
  failures: number;
}

/**
 * Work 97: generates a pharmacy's settlement statement automatically when its unsettled payable
 * reaches `settlement.autoRunMinAmount`, or when `settlement.autoRunPeriodDays` have passed since
 * its last statement (for a first statement, since its oldest unsettled posting), whichever comes
 * first.
 *
 * It only **generates** the DRAFT statement, through the same `RunSettlementCommand` finance uses
 * (audited, derived from the immutable ledger, postings already on a statement never counted
 * twice). Approval and payout still need two finance officers (maker-checker, NFR-SEC-06): nothing
 * here moves money.
 */
@Injectable()
export class SettlementAutoRunService {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRows: ILedgerRepository,
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly payable: ProviderPayableService,
    private readonly runSettlement: RunSettlementCommand,
  ) {
    this.logger.setContext(SettlementAutoRunService.name);
  }

  settings(): { minAmount: number; periodDays: number } {
    const read = (key: string, fallback: number) => {
      const value = Number(this.config.get<number>(key) ?? fallback);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    return {
      minAmount: read(SETTLEMENT_AUTO_RUN_MIN_AMOUNT_KEY, DEFAULT_SETTLEMENT_AUTO_RUN_MIN_AMOUNT),
      periodDays: read(SETTLEMENT_AUTO_RUN_PERIOD_DAYS_KEY, DEFAULT_SETTLEMENT_AUTO_RUN_PERIOD_DAYS),
    };
  }

  async run(now = new Date()): Promise<SettlementAutoRunReport> {
    const report: SettlementAutoRunReport = { examined: 0, generated: [], failures: 0 };
    const { minAmount, periodDays } = this.settings();
    if (minAmount === 0 && periodDays === 0) return report;

    const accounts = await this.ledgerRows.listAccountsByType(LedgerAccountType.PROVIDER_PAYABLE);
    for (const account of accounts) {
      if (!account.ownerId) continue;
      report.examined += 1;
      const pharmacyId = account.ownerId;
      const currency = account.currency;
      try {
        const last = await this.settlements.findLatestFor(pharmacyId, currency);
        const periodStart = last?.periodEnd ?? FIRST_SETTLEMENT_PERIOD_START;
        if (periodStart.getTime() >= now.getTime()) continue;
        const derived = await this.payable.derive(pharmacyId, currency, SettlementPeriod.of(periodStart, now));
        const oldest = derived.lines.reduce<Date | null>((min, l) => (!min || l.occurredAt < min ? l.occurredAt : min), null);
        const since = last?.periodEnd ?? oldest ?? now;
        const trigger = dueTrigger({ netPayable: derived.totals.netPayable, since, now, minAmount, periodDays });
        if (!trigger) continue;

        const result = await this.runSettlement.execute({ pharmacyId, currency, periodStart, periodEnd: now, actorUserId: null });
        report.generated.push({ pharmacyId, currency, settlementId: result.settlement.id, trigger, netPayable: derived.totals.netPayable });
        this.logger.log({ message: 'Settlement statement generated automatically', pharmacyId, currency, trigger, settlementId: result.settlement.id });
      } catch (err) {
        report.failures += 1;
        this.logger.error({
          message: 'Automatic settlement run failed for a pharmacy; it will be retried',
          pharmacyId,
          currency,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return report;
  }
}
