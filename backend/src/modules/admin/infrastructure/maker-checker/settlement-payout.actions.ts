import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalEntityType } from '@prisma/client';
import {
  ISettlementPayoutPort,
  SETTLEMENT_PAYOUT_PORT,
} from '../../../payment/application/ports/inbound/settlement-payout.port';
import {
  FINANCE_PAYOUT_PERMISSION,
  FINANCE_SETTLEMENT_PERMISSION,
} from '../../../payment/application/commands/approve-settlement.command';
import { AdminErrors } from '../../domain/errors';
import { MakerCheckerActionRegistry } from '../../domain/maker-checker/maker-checker-action';

/** The action types Work 83 registers (also `MAKER_CHECKER_ACTION_TYPES`). */
export const SETTLEMENT_APPROVE_ACTION = 'SETTLEMENT_APPROVE';
export const SETTLEMENT_PAYOUT_ACTION = 'SETTLEMENT_PAYOUT';
export const PAYOUT_BENEFICIARY_VERIFY_ACTION = 'PAYOUT_BENEFICIARY_VERIFY';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw AdminErrors.validation(`${field} must be a UUID.`, { field });
  }
  return value;
}

/** Display-only context the route adds for the checker; the executor never uses it. */
function money(payload: Record<string, unknown>): string {
  const amount = payload.netPayable;
  const currency = typeof payload.currency === 'string' ? payload.currency : '';
  return typeof amount === 'number' ? ` (${(amount / 100).toFixed(2)} ${currency})`.trimEnd() : '';
}

/**
 * Registers Module 07's settlement approval, payout and payout-destination verification as
 * maker-checker actions (Work 83, backend/docs/settlement-payout.md). Each executor calls Module 07's
 * own command through `SETTLEMENT_PAYOUT_PORT` with the checker's identity and permissions, so the
 * permission check, transaction, audit and idempotency are Module 07's.
 */
@Injectable()
export class SettlementPayoutActions implements OnModuleInit {
  constructor(
    private readonly registry: MakerCheckerActionRegistry,
    @Inject(SETTLEMENT_PAYOUT_PORT) private readonly payouts: ISettlementPayoutPort,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: SETTLEMENT_APPROVE_ACTION,
      entityType: ApprovalEntityType.PAYOUT,
      requiredPermission: FINANCE_SETTLEMENT_PERMISSION,
      describe: (payload) => {
        const settlementId = requireId(payload, 'settlementId');
        return { entityId: settlementId, summary: `Approve settlement ${settlementId} for payment${money(payload)}` };
      },
      execute: async (payload, ctx) => {
        const state = await this.payouts.approve(requireId(payload, 'settlementId'), {
          actorUserId: ctx.actorUserId,
          actorPermissions: ctx.actorPermissions,
        });
        return { settlementId: state.id, status: state.status, approvedAt: state.approvedAt?.toISOString() ?? null };
      },
    });

    this.registry.register({
      type: SETTLEMENT_PAYOUT_ACTION,
      entityType: ApprovalEntityType.PAYOUT,
      requiredPermission: FINANCE_PAYOUT_PERMISSION,
      describe: (payload) => {
        const settlementId = requireId(payload, 'settlementId');
        return { entityId: settlementId, summary: `Pay out settlement ${settlementId}${money(payload)}` };
      },
      execute: async (payload, ctx) => {
        const run = await this.payouts.pay(requireId(payload, 'settlementId'), {
          actorUserId: ctx.actorUserId,
          actorPermissions: ctx.actorPermissions,
          idempotencyKey: ctx.idempotencyKey,
        });
        return {
          settlementId: run.settlementId,
          status: run.status,
          attemptId: run.attempt.id,
          attemptStatus: run.attempt.status,
          reference: run.attempt.reference,
          providerReference: run.attempt.providerReference,
          amount: run.attempt.amount,
          currency: run.attempt.currency,
        };
      },
    });

    this.registry.register({
      type: PAYOUT_BENEFICIARY_VERIFY_ACTION,
      entityType: ApprovalEntityType.PAYOUT,
      requiredPermission: FINANCE_PAYOUT_PERMISSION,
      describe: (payload) => {
        const beneficiaryId = requireId(payload, 'beneficiaryId');
        const last4 = typeof payload.accountIdentifierLast4 === 'string' ? ` ending ${payload.accountIdentifierLast4}` : '';
        return { entityId: beneficiaryId, summary: `Verify payout destination ${beneficiaryId}${last4}` };
      },
      execute: async (payload, ctx) => {
        const b = await this.payouts.verifyBeneficiary(requireId(payload, 'beneficiaryId'), {
          actorUserId: ctx.actorUserId,
          actorPermissions: ctx.actorPermissions,
        });
        return {
          beneficiaryId: b.id,
          pharmacyId: b.pharmacyId,
          status: b.status,
          payableFrom: b.payableFrom?.toISOString() ?? null,
        };
      },
    });
  }
}
