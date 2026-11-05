import { Inject, Injectable } from '@nestjs/common';
import { SettlementStatus } from '@prisma/client';
import { AuditService } from '../../../../shared/audit/audit.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { PaymentErrors } from '../../domain/errors';
import {
  IPayoutRepository,
  PAYOUT_REPOSITORY,
  SettlementPayoutState,
} from '../../domain/repositories/payout.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';

import {
  FINANCE_PAYOUT_PERMISSION,
  FINANCE_SETTLEMENT_PERMISSION,
} from '../ports/inbound/settlement-payout.port';

// Defined on the inbound port, which Admin may import; re-exported for Module 07's own callers.
export { FINANCE_PAYOUT_PERMISSION, FINANCE_SETTLEMENT_PERMISSION };

export interface ApproveSettlementInput {
  settlementId: string;
  actorUserId: string;
  actorPermissions: readonly string[];
}

/**
 * `ApproveSettlement` — `DRAFT → APPROVED` (Work 83, module-07 §15.7). **Moves no money and posts
 * nothing**: approval is authorization to pay, not payment. Idempotent: approving an approved
 * statement answers it unchanged. Through Admin's maker-checker by default, so the approver is never
 * the operator who asked.
 */
@Injectable()
export class ApproveSettlementCommand {
  constructor(
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: IPayoutRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ApproveSettlementInput): Promise<SettlementPayoutState> {
    if (!hasPermission(input.actorPermissions, FINANCE_SETTLEMENT_PERMISSION)) {
      throw PaymentErrors.payoutPermissionMissing(FINANCE_SETTLEMENT_PERMISSION);
    }
    const current = await this.payouts.findSettlementState(input.settlementId);
    if (!current) {
      throw PaymentErrors.settlementNotFound();
    }
    if (current.status === SettlementStatus.APPROVED) {
      return current;
    }
    if (current.status !== SettlementStatus.DRAFT) {
      throw PaymentErrors.invalidSettlementStateTransition(current.status, SettlementStatus.APPROVED);
    }

    return this.uow.run(async (tx) => {
      const approvedAt = new Date();
      const moved = await this.payouts.transitionSettlement(
        current.id,
        [SettlementStatus.DRAFT],
        SettlementStatus.APPROVED,
        { approvedByUserId: input.actorUserId, approvedAt },
        tx,
      );
      if (!moved) {
        const raced = await this.payouts.findSettlementState(current.id, tx);
        if (raced?.status === SettlementStatus.APPROVED) return raced;
        throw PaymentErrors.invalidSettlementStateTransition(raced?.status ?? current.status, SettlementStatus.APPROVED);
      }
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'SETTLEMENT_APPROVED',
          resourceType: 'Settlement',
          resourceId: current.id,
          context: {
            pharmacyId: current.pharmacyId,
            netPayable: current.netPayable,
            currency: current.currency,
          },
        },
        tx,
      );
      return (await this.payouts.findSettlementState(current.id, tx)) as SettlementPayoutState;
    });
  }
}
