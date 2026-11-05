import { Inject, Injectable } from '@nestjs/common';
import { PayoutAttemptStatus, SettlementStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ENCRYPTION_PORT, IEncryptionPort } from '../../../../shared/crypto/crypto.port';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../../domain/enums';
import { PaymentErrors } from '../../domain/errors';
import { settlementPaidEvent } from '../../domain/events';
import { ILedgerRepository, LEDGER_REPOSITORY } from '../../domain/repositories/ledger.repository';
import {
  IPayoutRepository,
  PAYOUT_REPOSITORY,
  PayoutAttemptProps,
  PayoutBeneficiaryProps,
  toAttemptView,
} from '../../domain/repositories/payout.repository';
import {
  ISettlementRepository,
  SETTLEMENT_REPOSITORY,
} from '../../domain/repositories/settlement.repository';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRef } from '../../domain/value-objects/account-ref.vo';
import { Money } from '../../domain/value-objects/money.vo';
import {
  IPayoutProviderPort,
  PAYOUT_PROVIDER_PORT,
  PayoutOutcome,
  PayoutResult,
} from '../ports/outbound/payout-provider.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithPaymentRetry } from '../support/payment-retry';
import { sanitizeProviderFailureReason } from '../support/sanitize-provider-failure';
import { FINANCE_PAYOUT_PERMISSION } from './approve-settlement.command';

/** The ledger's exactly-once key for a settlement's payout (ADR-024). */
export const settlementLedgerReference = (settlementId: string) => `SETTLEMENT-${settlementId}`;
/** The provider-facing key for one attempt (ADR-024). */
export const payoutAttemptReference = (attemptId: string) => `PAYOUT-${attemptId}`;

export interface ExecutePayoutInput {
  settlementId: string;
  actorUserId: string;
  actorPermissions: readonly string[];
  /** BRULE-25. `approval:<id>` when the payout came through maker-checker. */
  idempotencyKey: string;
}

export interface PayoutRunResult {
  settlementId: string;
  status: SettlementStatus;
  attempt: Omit<PayoutAttemptProps, 'idempotencyKey'>;
}

/**
 * `ExecutePayout` (Work 83; module-07 §15.6–15.8, ADR-022..026).
 *
 * 1. Refuse before writing anything: no `finance:payout:any`, a statement that is not APPROVED (or
 *    FAILED, for a retry), nothing to pay, no verified destination that may receive money now, or no
 *    payout rail in this process.
 * 2. Commit `PROCESSING` and a PENDING attempt **before** the provider call (ADR-024): the commit is
 *    what makes the external side effect idempotent. One open attempt per statement (unique index).
 * 3. Call the rail with `PAYOUT-<attemptId>`.
 * 4. Resolve: PAID/ALREADY_PAID → the `SETTLEMENT` posting (DEBIT PROVIDER_PAYABLE, CREDIT
 *    GATEWAY_CLEARING, the **stored** `netPayable`, keyed `SETTLEMENT-<id>` so it exists once), PAID,
 *    `paidAt`, audit, `settlement.paid`. FAILED → no posting, FAILED (retry allowed). PENDING/UNKNOWN or
 *    a thrown call → **nothing written**; the statement stays PROCESSING for `refresh`.
 *
 * A repeat with the same idempotency key finds its attempt and resolves it rather than paying again.
 */
@Injectable()
export class ExecutePayoutCommand {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: IPayoutRepository,
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRows: ILedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(PAYOUT_PROVIDER_PORT) private readonly rail: IPayoutProviderPort,
    @Inject(ENCRYPTION_PORT) private readonly crypto: IEncryptionPort,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ExecutePayoutInput): Promise<PayoutRunResult> {
    if (!hasPermission(input.actorPermissions, FINANCE_PAYOUT_PERMISSION)) {
      throw PaymentErrors.payoutPermissionMissing(FINANCE_PAYOUT_PERMISSION);
    }
    const key = (input.idempotencyKey ?? '').trim();
    if (!key) {
      throw PaymentErrors.validation('An idempotency key is required.', { field: 'idempotencyKey' });
    }

    const previous = await this.payouts.findAttemptByKey(key);
    if (previous) {
      if (previous.settlementId !== input.settlementId) {
        throw PaymentErrors.idempotencyConflict({ field: 'idempotencyKey' });
      }
      return this.resolveOpen(previous, input.actorUserId, () => this.rail.getStatus(previous.reference));
    }

    const state = await this.payouts.findSettlementState(input.settlementId);
    if (!state) {
      throw PaymentErrors.settlementNotFound();
    }
    if (state.status === SettlementStatus.PROCESSING) {
      const open = await this.payouts.findOpenAttempt(state.id);
      throw PaymentErrors.payoutInProgress(open?.id ?? '');
    }
    if (state.status !== SettlementStatus.APPROVED && state.status !== SettlementStatus.FAILED) {
      throw PaymentErrors.invalidSettlementStateTransition(state.status, SettlementStatus.PROCESSING);
    }
    if (state.netPayable <= 0) {
      throw PaymentErrors.settlementNothingToPay(state.netPayable);
    }
    const beneficiary = await this.payouts.findVerifiedBeneficiary(state.pharmacyId);
    if (!beneficiary) {
      throw PaymentErrors.payoutBeneficiaryRequired(state.pharmacyId, { reason: 'none_verified' });
    }
    if (!beneficiary.payableFrom || beneficiary.payableFrom.getTime() > Date.now()) {
      throw PaymentErrors.payoutBeneficiaryRequired(state.pharmacyId, {
        reason: 'cooling_off',
        payableFrom: beneficiary.payableFrom?.toISOString() ?? null,
      });
    }
    if (!this.rail.isAvailable()) {
      throw PaymentErrors.paymentProviderUnavailable(this.rail.key, { reason: 'no_payout_rail' });
    }

    const attemptId = randomUUID();
    const attempt = await this.uow.run(async (tx) => {
      const moved = await this.payouts.transitionSettlement(
        state.id,
        [SettlementStatus.APPROVED, SettlementStatus.FAILED],
        SettlementStatus.PROCESSING,
        {},
        tx,
      );
      if (!moved) {
        throw PaymentErrors.invalidSettlementStateTransition('changed', SettlementStatus.PROCESSING);
      }
      const row = await this.payouts.insertAttempt(
        {
          id: attemptId,
          settlementId: state.id,
          beneficiaryId: beneficiary.id,
          idempotencyKey: key,
          reference: payoutAttemptReference(attemptId),
          providerKey: this.rail.key,
          amount: state.netPayable,
          currency: state.currency,
          initiatedByUserId: input.actorUserId,
        },
        tx,
      );
      if (!row) {
        throw PaymentErrors.payoutInProgress('');
      }
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PAYOUT_INITIATED',
          resourceType: 'Settlement',
          resourceId: state.id,
          context: {
            attemptId: row.id,
            reference: row.reference,
            amount: row.amount,
            currency: row.currency,
            provider: row.providerKey,
            beneficiaryId: beneficiary.id,
            accountIdentifierLast4: beneficiary.accountIdentifierLast4,
          },
        },
        tx,
      );
      return row;
    });

    return this.resolveOpen(attempt, input.actorUserId, () => this.rail.pay(this.requestFor(attempt, state.pharmacyId, beneficiary)));
  }

  /** `POST .../payout/refresh`: asks the rail about the open attempt and resolves it. Moves no money itself. */
  async refresh(input: { settlementId: string; actorUserId: string; actorPermissions: readonly string[] }): Promise<PayoutRunResult> {
    if (!hasPermission(input.actorPermissions, FINANCE_PAYOUT_PERMISSION)) {
      throw PaymentErrors.payoutPermissionMissing(FINANCE_PAYOUT_PERMISSION);
    }
    const open = await this.payouts.findOpenAttempt(input.settlementId);
    if (!open) {
      const state = await this.payouts.findSettlementState(input.settlementId);
      if (!state) throw PaymentErrors.settlementNotFound();
      throw PaymentErrors.invalidSettlementStateTransition(state.status, 'refreshed');
    }
    if (!this.rail.isAvailable()) {
      throw PaymentErrors.paymentProviderUnavailable(this.rail.key, { reason: 'no_payout_rail' });
    }
    return this.resolveOpen(open, input.actorUserId, () => this.rail.getStatus(open.reference));
  }

  private requestFor(attempt: PayoutAttemptProps, pharmacyId: string, b: PayoutBeneficiaryProps) {
    return {
      reference: attempt.reference,
      settlementId: attempt.settlementId,
      pharmacyId,
      amount: attempt.amount,
      currency: attempt.currency,
      beneficiary: {
        rail: b.rail,
        accountName: b.accountName,
        bankCode: b.bankCode,
        accountIdentifier: this.crypto.decryptFromString(b.accountIdentifierEncrypted).toString('utf8'),
      },
    };
  }

  private async resolveOpen(
    attempt: PayoutAttemptProps,
    actorUserId: string,
    ask: () => Promise<PayoutResult>,
  ): Promise<PayoutRunResult> {
    if (attempt.status === PayoutAttemptStatus.PAID || attempt.status === PayoutAttemptStatus.FAILED) {
      return this.result(attempt);
    }
    let answer: PayoutResult;
    try {
      answer = await ask();
    } catch {
      // A thrown call is an undeterminable outcome, never a decline (ADR-023): nothing is written.
      return this.markUnknown(attempt);
    }

    switch (answer.outcome) {
      case PayoutOutcome.PAID:
      case PayoutOutcome.ALREADY_PAID:
        return this.confirmPaid(attempt, answer, actorUserId);
      case PayoutOutcome.FAILED: {
        const reason = sanitizeProviderFailureReason(answer.failureReason ?? 'declined');
        const failed = await this.recordDecline(attempt, reason, actorUserId);
        throw PaymentErrors.payoutDeclined(reason, { settlementId: failed.settlementId, attemptId: failed.id });
      }
      case PayoutOutcome.UNKNOWN:
        return this.markUnknown(attempt);
      default:
        return this.result(attempt);
    }
  }

  private async markUnknown(attempt: PayoutAttemptProps): Promise<PayoutRunResult> {
    if (attempt.status === PayoutAttemptStatus.PENDING) {
      // Only the attempt's own status records that the answer was undeterminable; the statement
      // stays PROCESSING and no posting is written either way.
      const updated = await this.payouts.resolveAttempt(attempt.id, { status: PayoutAttemptStatus.UNKNOWN });
      return this.result(updated ?? attempt);
    }
    return this.result(attempt);
  }

  private async confirmPaid(
    attempt: PayoutAttemptProps,
    answer: PayoutResult,
    actorUserId: string,
  ): Promise<PayoutRunResult> {
    const settlement = await this.settlements.findById(attempt.settlementId);
    const resolved = await runWithPaymentRetry(this.uow, async (tx) => {
      const paidAt = new Date();
      const updated = await this.payouts.resolveAttempt(
        attempt.id,
        { status: PayoutAttemptStatus.PAID, providerReference: answer.providerReference ?? null, completedAt: paidAt },
        tx,
      );
      if (!updated) {
        // Resolved concurrently (a second refresh); read the winner.
        return (await this.payouts.findAttemptByKey(attempt.idempotencyKey, tx)) ?? attempt;
      }
      const reference = settlementLedgerReference(attempt.settlementId);
      if (!(await this.ledgerRows.findTransactionByReference(reference, tx))) {
        const [payable, clearing] = await Promise.all([
          this.ledger.resolveAccount(AccountRef.providerPayable(settlement?.pharmacyId ?? '', attempt.currency), tx),
          this.ledger.resolveAccount(AccountRef.platform(LedgerAccountType.GATEWAY_CLEARING, attempt.currency), tx),
        ]);
        const amount = Money.of(attempt.amount, attempt.currency);
        await this.ledger.post(
          {
            reference,
            type: LedgerTransactionType.SETTLEMENT,
            refType: 'settlement',
            refId: attempt.settlementId,
            description: `Payout for settlement ${settlement?.statementRef ?? attempt.settlementId}`,
            entries: [
              { accountId: payable.id, direction: LedgerDirection.DEBIT, amount },
              { accountId: clearing.id, direction: LedgerDirection.CREDIT, amount },
            ],
          },
          tx,
        );
      }
      await this.payouts.transitionSettlement(
        attempt.settlementId,
        [SettlementStatus.PROCESSING],
        SettlementStatus.PAID,
        { paidAt },
        tx,
      );
      await this.audit.record(
        {
          actorUserId,
          action: 'SETTLEMENT_PAID',
          resourceType: 'Settlement',
          resourceId: attempt.settlementId,
          context: {
            attemptId: attempt.id,
            reference: attempt.reference,
            providerReference: answer.providerReference ?? null,
            amount: attempt.amount,
            currency: attempt.currency,
            ledgerReference: reference,
            alreadyPaid: answer.outcome === PayoutOutcome.ALREADY_PAID,
          },
        },
        tx,
      );
      await this.outbox.write(
        settlementPaidEvent({
          settlementId: attempt.settlementId,
          pharmacyId: settlement?.pharmacyId ?? '',
          amount: attempt.amount,
          currency: attempt.currency,
          statementRef: settlement?.statementRef ?? null,
          payoutReference: attempt.reference,
        }),
        tx as OutboxCapableClient,
      );
      return updated;
    });
    return this.result(resolved);
  }

  private async recordDecline(
    attempt: PayoutAttemptProps,
    reason: string,
    actorUserId: string,
  ): Promise<PayoutAttemptProps> {
    return this.uow.run(async (tx) => {
      const updated = await this.payouts.resolveAttempt(
        attempt.id,
        { status: PayoutAttemptStatus.FAILED, failureReason: reason, completedAt: new Date() },
        tx,
      );
      if (!updated) {
        return (await this.payouts.findAttemptByKey(attempt.idempotencyKey, tx)) ?? attempt;
      }
      await this.payouts.transitionSettlement(
        attempt.settlementId,
        [SettlementStatus.PROCESSING],
        SettlementStatus.FAILED,
        {},
        tx,
      );
      await this.audit.record(
        {
          actorUserId,
          action: 'PAYOUT_FAILED',
          resourceType: 'Settlement',
          resourceId: attempt.settlementId,
          context: { attemptId: attempt.id, reference: attempt.reference, reason },
        },
        tx,
      );
      return updated;
    });
  }

  private async result(attempt: PayoutAttemptProps): Promise<PayoutRunResult> {
    const state = await this.payouts.findSettlementState(attempt.settlementId);
    return { settlementId: attempt.settlementId, status: state?.status ?? SettlementStatus.PROCESSING, attempt: toAttemptView(attempt) };
  }
}
