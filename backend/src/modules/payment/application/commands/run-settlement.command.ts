import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  Settlement,
  SettlementLineProps,
  SettlementWithLines,
  toSettlementLineProps,
} from '../../domain/entities/settlement.entity';
import { PaymentErrors } from '../../domain/errors';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
} from '../../domain/repositories/payment.repository';
import {
  IRefundRepository,
  REFUND_REPOSITORY,
} from '../../domain/repositories/refund.repository';
import {
  ISettlementRepository,
  SETTLEMENT_REPOSITORY,
} from '../../domain/repositories/settlement.repository';
import { SettlementLineDraft } from '../../domain/services/settlement-calculator';
import { BASE_CURRENCY } from '../../domain/value-objects/currency.vo';
import { SettlementPeriod } from '../../domain/value-objects/settlement-period.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { isUniqueConstraintViolation, runWithPaymentRetry } from '../support/payment-retry';
import { ProviderPayableService } from '../services/provider-payable.service';

export interface RunSettlementInput {
  pharmacyId: string;
  periodStart: Date;
  periodEnd: Date;
  currency?: string;
  /** Who triggered the run, for the audit trail. `null` for a scheduled one. */
  actorUserId?: string | null;
}

export interface RunSettlementResult extends SettlementWithLines {
  /** `true` when an already-committed statement was returned rather than a new one generated. */
  replay: boolean;
}

/**
 * `RunSettlement` (§11.5, F-STL-02) — generates one provider's `DRAFT` statement for one period.
 *
 * ## It moves no money
 *
 * This is a **read of the ledger written down**, not a transfer. It posts nothing: no
 * `SETTLEMENT` transaction, no debit of `PROVIDER_PAYABLE`, no change to any balance. §11.5's
 * posting (`DEBIT Provider-Payable; CREDIT Gateway-Clearing`) belongs to `ExecutePayout`, which
 * needs a payout provider to exist first — and that is explicitly out of scope. A statement that
 * debited the payable before anyone was paid would report money as sent that nobody sent, and
 * being a ledger posting it could never be corrected, only offset.
 *
 * ## Idempotency
 *
 * The identity is `(pharmacyId, periodStart, periodEnd, currency)`, backed by a unique index —
 * the same deterministic-natural-key discipline capture, refund, wallet and coupon redemption
 * already use, rather than a second mechanism racing them. A re-run returns the committed
 * statement with `replay: true`; it does not regenerate, and it does not update. That matters more
 * here than elsewhere: statements are what an operator approves and pays against, so silently
 * rewriting one an operator has already seen is the failure mode to design out.
 *
 * The check happens twice — cheaply before the transaction, and again inside it, because the first
 * read can be raced. If even that loses, the unique-index violation is caught and resolved by
 * returning the winner, exactly as `ApplyCouponCommand` resolves its own race.
 *
 * ## Why the derivation happens inside the transaction
 *
 * The ledger is append-only, so a posting cannot change under the run — but a new one can *arrive*
 * mid-read. Deriving inside the same `Serializable` transaction that inserts means the statement's
 * lines and its totals are a consistent snapshot of one instant, and a posting written during the
 * run lands wholly in this statement or wholly in the next, never half in each.
 */
@Injectable()
export class RunSettlementCommand {
  constructor(
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(REFUND_REPOSITORY) private readonly refunds: IRefundRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly payable: ProviderPayableService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RunSettlementInput): Promise<RunSettlementResult> {
    const pharmacyId = requireText(input.pharmacyId, 'pharmacyId');
    const currency = (input.currency ?? BASE_CURRENCY).trim().toUpperCase();
    const period = SettlementPeriod.of(input.periodStart, input.periodEnd);
    const identity = {
      pharmacyId,
      periodStart: period.start,
      periodEnd: period.end,
      currency,
    };

    // Cheap replay: a scheduled run that already completed does no ledger work at all.
    const existing = await this.settlements.findByIdentity(identity);
    if (existing) {
      return this.replay(existing.id);
    }

    try {
      return await runWithPaymentRetry(this.uow, async (tx) => {
        const raced = await this.settlements.findByIdentity(identity, tx);
        if (raced) {
          const loaded = await this.settlements.findWithLines(raced.id, tx);
          return { ...(loaded as SettlementWithLines), replay: true };
        }

        const derived = await this.payable.derive(pharmacyId, currency, period, tx);
        const settlement = Settlement.create({
          id: randomUUID(),
          pharmacyId,
          periodStart: period.start,
          periodEnd: period.end,
          currency,
          totals: derived.totals,
        }).toProps();

        const lines: SettlementLineProps[] = [];
        for (const draft of derived.lines) {
          lines.push(
            toSettlementLineProps(draft, {
              id: randomUUID(),
              settlementId: settlement.id,
              orderId: await this.resolveOrderId(draft, tx),
            }),
          );
        }

        const written = await this.settlements.create(settlement, lines, tx);

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? null,
            action: 'SETTLEMENT_GENERATED',
            resourceType: 'Settlement',
            resourceId: settlement.id,
            context: {
              pharmacyId,
              currency,
              period: period.toString(),
              statementRef: settlement.statementRef,
              // The figures, and the ledger references they came from. §13 requires the trail to
              // identify the source data, and these references are what makes the statement
              // reproducible without re-deriving any historical pricing.
              providerPayableGross: settlement.providerPayableGross,
              refundClawback: settlement.refundClawback,
              netPayable: settlement.netPayable,
              platformRevenue: settlement.platformRevenue,
              promotionExpense: settlement.promotionExpense,
              customerCashCollected: settlement.customerCashCollected,
              ledgerReferences: lines.map((line) => line.ledgerReference),
            },
          },
          tx,
        );

        return { ...written, replay: false };
      });
    } catch (err) {
      // Two concurrent runs for one period raced the unique index. The loser returns the winner's
      // statement rather than reporting a conflict a scheduler would only retry into again.
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.settlements.findByIdentity(identity);
        if (winner) {
          return this.replay(winner.id);
        }
      }
      throw err;
    }
  }

  /**
   * Labels a line with its order, when one can be resolved.
   *
   * Purely a label. The figures come from the posting; this only follows `refType`/`refId` to the
   * payment (or to the refund and then its payment) so a statement can be read next to an order
   * list. A missing link leaves `null` rather than failing the run — reconciliation reports a
   * dangling source, which is the right place for it.
   */
  private async resolveOrderId(
    draft: SettlementLineDraft,
    tx?: unknown,
  ): Promise<string | null> {
    if (!draft.refId) {
      return null;
    }
    if (draft.refType === 'payment') {
      return (await this.payments.findById(draft.refId, tx))?.orderId ?? null;
    }
    if (draft.refType === 'refund') {
      const refund = await this.refunds.findById(draft.refId, tx);
      if (!refund) {
        return null;
      }
      return (await this.payments.findById(refund.paymentId, tx))?.orderId ?? null;
    }
    return null;
  }

  private async replay(settlementId: string): Promise<RunSettlementResult> {
    const loaded = await this.settlements.findWithLines(settlementId);
    if (!loaded) {
      throw PaymentErrors.notFound('Settlement not found.', { settlementId });
    }
    return { ...loaded, replay: true };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw PaymentErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
