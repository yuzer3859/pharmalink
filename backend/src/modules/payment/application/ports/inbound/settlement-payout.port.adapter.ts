import { Inject, Injectable } from '@nestjs/common';
import { PayoutRail } from '@prisma/client';
import { ApproveSettlementCommand } from '../../commands/approve-settlement.command';
import { ExecutePayoutCommand } from '../../commands/execute-payout.command';
import {
  RegisterPayoutBeneficiaryCommand,
  toBeneficiaryView,
  VerifyPayoutBeneficiaryCommand,
} from '../../commands/payout-beneficiary.commands';
import {
  IPayoutRepository,
  PAYOUT_REPOSITORY,
  toAttemptView,
} from '../../../domain/repositories/payout.repository';
import {
  Actor,
  ISettlementPayoutPort,
  PayoutBeneficiaryView,
  SettlementPayoutView,
} from './settlement-payout.port';

@Injectable()
export class SettlementPayoutPortAdapter implements ISettlementPayoutPort {
  constructor(
    private readonly approveCommand: ApproveSettlementCommand,
    private readonly payoutCommand: ExecutePayoutCommand,
    private readonly registerCommand: RegisterPayoutBeneficiaryCommand,
    private readonly verifyCommand: VerifyPayoutBeneficiaryCommand,
    @Inject(PAYOUT_REPOSITORY) private readonly payouts: IPayoutRepository,
  ) {}

  approve(settlementId: string, actor: Actor) {
    return this.approveCommand.execute({ settlementId, ...actor });
  }

  pay(settlementId: string, actor: Actor & { idempotencyKey: string }) {
    return this.payoutCommand.execute({ settlementId, ...actor });
  }

  refresh(settlementId: string, actor: Actor) {
    return this.payoutCommand.refresh({ settlementId, ...actor });
  }

  async payoutView(settlementId: string): Promise<SettlementPayoutView | null> {
    const settlement = await this.payouts.findSettlementState(settlementId);
    if (!settlement) return null;
    const [attempts, beneficiary] = await Promise.all([
      this.payouts.listAttempts(settlementId),
      this.payouts.findVerifiedBeneficiary(settlement.pharmacyId),
    ]);
    return {
      settlement,
      attempts: attempts.map(toAttemptView),
      beneficiary: beneficiary ? toBeneficiaryView(beneficiary) : null,
    };
  }

  async listBeneficiaries(pharmacyId: string): Promise<PayoutBeneficiaryView[]> {
    return (await this.payouts.findBeneficiaries(pharmacyId)).map(toBeneficiaryView);
  }

  async findBeneficiary(beneficiaryId: string): Promise<PayoutBeneficiaryView | null> {
    const b = await this.payouts.findBeneficiary(beneficiaryId);
    return b ? toBeneficiaryView(b) : null;
  }

  registerBeneficiary(
    input: { pharmacyId: string; rail: PayoutRail; accountName: string; bankCode?: string | null; accountIdentifier: string },
    actor: Actor,
  ) {
    return this.registerCommand.execute({ ...input, ...actor });
  }

  verifyBeneficiary(beneficiaryId: string, actor: Actor) {
    return this.verifyCommand.execute({ beneficiaryId, ...actor });
  }
}
