import {
  PayoutAttemptStatus,
  PayoutBeneficiaryStatus,
  PayoutRail,
  SettlementStatus,
} from '@prisma/client';

export { PayoutAttemptStatus, PayoutBeneficiaryStatus, PayoutRail };

export const PAYOUT_REPOSITORY = Symbol('PAYOUT_REPOSITORY');

/** A beneficiary as the domain sees it. The encrypted identifier never leaves the repository's callers. */
export interface PayoutBeneficiaryProps {
  id: string;
  pharmacyId: string;
  rail: PayoutRail;
  accountName: string;
  bankCode: string | null;
  accountIdentifierEncrypted: string;
  accountIdentifierLast4: string;
  status: PayoutBeneficiaryStatus;
  createdByUserId: string;
  verifiedByUserId: string | null;
  verifiedAt: Date | null;
  payableFrom: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
}

export interface PayoutAttemptProps {
  id: string;
  settlementId: string;
  beneficiaryId: string;
  idempotencyKey: string;
  reference: string;
  providerKey: string;
  amount: number;
  currency: string;
  status: PayoutAttemptStatus;
  providerReference: string | null;
  failureReason: string | null;
  initiatedByUserId: string;
  createdAt: Date;
  completedAt: Date | null;
}

/** An attempt as callers outside the command see it: without the caller's idempotency key. */
export type PayoutAttemptView = Omit<PayoutAttemptProps, 'idempotencyKey'>;

export function toAttemptView(attempt: PayoutAttemptProps): PayoutAttemptView {
  const view: Partial<PayoutAttemptProps> = { ...attempt };
  delete view.idempotencyKey;
  return view as PayoutAttemptView;
}

/** The payout-side facts of a settlement that `SettlementProps` (immutable, ADR) does not carry. */
export interface SettlementPayoutState {
  id: string;
  pharmacyId: string;
  currency: string;
  netPayable: number;
  status: SettlementStatus;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  paidAt: Date | null;
}

/**
 * Payout lifecycle persistence (Work 83). The only writer of a settlement's status after
 * generation, and every write is conditional on the status it expects, so two operators (or a
 * resumed run) cannot both move a statement.
 */
export interface IPayoutRepository {
  findSettlementState(settlementId: string, tx?: unknown): Promise<SettlementPayoutState | null>;

  /**
   * Work 96: `CAPTURED -> SETTLED` for every payment whose capture this statement pays out (its
   * payout lines with source `payment`). Returns the ids actually moved; a second call moves none.
   */
  settleStatementPayments(settlementId: string, at: Date, tx?: unknown): Promise<string[]>;

  /** `from → to` with the extra columns; `false` when the settlement was not in one of `from`. */
  transitionSettlement(
    settlementId: string,
    from: SettlementStatus[],
    to: SettlementStatus,
    extra: { approvedByUserId?: string; approvedAt?: Date; paidAt?: Date },
    tx?: unknown,
  ): Promise<boolean>;

  insertBeneficiary(
    beneficiary: Omit<
      PayoutBeneficiaryProps,
      'status' | 'verifiedByUserId' | 'verifiedAt' | 'payableFrom' | 'supersededAt' | 'createdAt'
    >,
    tx?: unknown,
  ): Promise<PayoutBeneficiaryProps | null>;

  findBeneficiary(id: string, tx?: unknown): Promise<PayoutBeneficiaryProps | null>;
  findBeneficiaries(pharmacyId: string, tx?: unknown): Promise<PayoutBeneficiaryProps[]>;
  findVerifiedBeneficiary(pharmacyId: string, tx?: unknown): Promise<PayoutBeneficiaryProps | null>;

  /** Marks the pharmacy's VERIFIED beneficiary (if any) SUPERSEDED; returns whether there was one. */
  supersedeVerified(pharmacyId: string, at: Date, tx?: unknown): Promise<boolean>;

  /** PENDING_VERIFICATION → VERIFIED; `null` when it was no longer pending. */
  verifyBeneficiary(
    id: string,
    change: { verifiedByUserId: string; verifiedAt: Date; payableFrom: Date },
    tx?: unknown,
  ): Promise<PayoutBeneficiaryProps | null>;

  /** `null` when an open attempt already exists for the settlement or the key was used. */
  insertAttempt(
    attempt: Omit<PayoutAttemptProps, 'status' | 'providerReference' | 'failureReason' | 'createdAt' | 'completedAt'>,
    tx?: unknown,
  ): Promise<PayoutAttemptProps | null>;

  findAttemptByKey(idempotencyKey: string, tx?: unknown): Promise<PayoutAttemptProps | null>;
  findOpenAttempt(settlementId: string, tx?: unknown): Promise<PayoutAttemptProps | null>;
  listAttempts(settlementId: string, tx?: unknown): Promise<PayoutAttemptProps[]>;

  /** Moves an open (PENDING/UNKNOWN) attempt; `null` when it was already resolved. */
  resolveAttempt(
    id: string,
    change: {
      status: PayoutAttemptStatus;
      providerReference?: string | null;
      failureReason?: string | null;
      completedAt?: Date | null;
    },
    tx?: unknown,
  ): Promise<PayoutAttemptProps | null>;
}
