import type { PayoutRail } from '@prisma/client';
import type { PayoutBeneficiaryView } from '../../commands/payout-beneficiary.commands';
import type { PayoutRunResult } from '../../commands/execute-payout.command';
import type {
  PayoutAttemptProps,
  SettlementPayoutState,
} from '../../../domain/repositories/payout.repository';

export const SETTLEMENT_PAYOUT_PORT = Symbol('SETTLEMENT_PAYOUT_PORT');

/** Approving a statement for payment (module-07 §15.11). */
export const FINANCE_SETTLEMENT_PERMISSION = 'finance:settlement:any';
/** Disbursing money and verifying where it goes (§15.3): never shared with generation. */
export const FINANCE_PAYOUT_PERMISSION = 'finance:payout:any';

export type { PayoutBeneficiaryView, PayoutRunResult, SettlementPayoutState };

export interface Actor {
  actorUserId: string;
  actorPermissions: readonly string[];
}

export interface SettlementPayoutView {
  settlement: SettlementPayoutState;
  attempts: Array<Omit<PayoutAttemptProps, 'idempotencyKey'>>;
  /** The destination a payout would use now, if any. */
  beneficiary: PayoutBeneficiaryView | null;
}

/**
 * Module 07's settlement approval and payout, for Admin's maker-checker executors and routes
 * (Work 83). Every method runs Module 07's own command, with its permission check, transaction,
 * audit and idempotency; Admin never touches settlement or payout rows.
 */
export interface ISettlementPayoutPort {
  approve(settlementId: string, actor: Actor): Promise<SettlementPayoutState>;
  pay(settlementId: string, actor: Actor & { idempotencyKey: string }): Promise<PayoutRunResult>;
  refresh(settlementId: string, actor: Actor): Promise<PayoutRunResult>;
  /** `null` when the settlement does not exist. */
  payoutView(settlementId: string): Promise<SettlementPayoutView | null>;

  listBeneficiaries(pharmacyId: string): Promise<PayoutBeneficiaryView[]>;
  findBeneficiary(beneficiaryId: string): Promise<PayoutBeneficiaryView | null>;
  registerBeneficiary(
    input: {
      pharmacyId: string;
      rail: PayoutRail;
      accountName: string;
      bankCode?: string | null;
      accountIdentifier: string;
    },
    actor: Actor,
  ): Promise<PayoutBeneficiaryView>;
  verifyBeneficiary(beneficiaryId: string, actor: Actor): Promise<PayoutBeneficiaryView>;
}
