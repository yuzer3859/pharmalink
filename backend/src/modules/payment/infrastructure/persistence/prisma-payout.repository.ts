import { Injectable } from '@nestjs/common';
import {
  PayoutAttempt,
  PayoutAttemptStatus,
  PayoutBeneficiary,
  PayoutBeneficiaryStatus,
  Prisma,
  SettlementStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPayoutRepository,
  PayoutAttemptProps,
  PayoutBeneficiaryProps,
  SettlementPayoutState,
} from '../../domain/repositories/payout.repository';

type Client = PrismaService | Prisma.TransactionClient;

const OPEN_ATTEMPT = [PayoutAttemptStatus.PENDING, PayoutAttemptStatus.UNKNOWN];

@Injectable()
export class PrismaPayoutRepository implements IPayoutRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSettlementState(settlementId: string, tx?: unknown): Promise<SettlementPayoutState | null> {
    const row = await this.client(tx).settlement.findUnique({ where: { id: settlementId } });
    if (!row) return null;
    return {
      id: row.id,
      pharmacyId: row.pharmacyId,
      currency: row.currency,
      netPayable: row.netAmount,
      status: row.status,
      approvedByUserId: row.approvedByUserId,
      approvedAt: row.approvedAt,
      paidAt: row.paidAt,
    };
  }

  async settleStatementPayments(settlementId: string, at: Date, tx?: unknown): Promise<string[]> {
    const client = this.client(tx);
    const lines = await client.payoutLine.findMany({
      where: { settlementId, sourceRefType: 'payment', sourceRefId: { not: null } },
      select: { sourceRefId: true },
    });
    const ids = [...new Set(lines.map((l) => l.sourceRefId as string))];
    if (ids.length === 0) return [];
    const captured = await client.payment.findMany({ where: { id: { in: ids }, status: 'CAPTURED' }, select: { id: true } });
    const settled = captured.map((p) => p.id);
    if (settled.length > 0) {
      await client.payment.updateMany({ where: { id: { in: settled }, status: 'CAPTURED' }, data: { status: 'SETTLED', updatedAt: at } });
    }
    return settled;
  }

  async transitionSettlement(
    settlementId: string,
    from: SettlementStatus[],
    to: SettlementStatus,
    extra: { approvedByUserId?: string; approvedAt?: Date; paidAt?: Date },
    tx?: unknown,
  ): Promise<boolean> {
    const { count } = await this.client(tx).settlement.updateMany({
      where: { id: settlementId, status: { in: from } },
      data: { status: to, ...extra },
    });
    return count === 1;
  }

  async insertBeneficiary(
    b: Parameters<IPayoutRepository['insertBeneficiary']>[0],
    tx?: unknown,
  ): Promise<PayoutBeneficiaryProps | null> {
    try {
      const row = await this.client(tx).payoutBeneficiary.create({
        data: {
          id: b.id,
          pharmacyId: b.pharmacyId,
          rail: b.rail,
          accountName: b.accountName,
          bankCode: b.bankCode,
          accountIdentifierEncrypted: b.accountIdentifierEncrypted,
          accountIdentifierLast4: b.accountIdentifierLast4,
          createdByUserId: b.createdByUserId,
        },
      });
      return toBeneficiary(row);
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  async findBeneficiary(id: string, tx?: unknown): Promise<PayoutBeneficiaryProps | null> {
    const row = await this.client(tx).payoutBeneficiary.findUnique({ where: { id } });
    return row ? toBeneficiary(row) : null;
  }

  async findBeneficiaries(pharmacyId: string, tx?: unknown): Promise<PayoutBeneficiaryProps[]> {
    const rows = await this.client(tx).payoutBeneficiary.findMany({
      where: { pharmacyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toBeneficiary);
  }

  async findVerifiedBeneficiary(pharmacyId: string, tx?: unknown): Promise<PayoutBeneficiaryProps | null> {
    const row = await this.client(tx).payoutBeneficiary.findFirst({
      where: { pharmacyId, status: PayoutBeneficiaryStatus.VERIFIED },
    });
    return row ? toBeneficiary(row) : null;
  }

  async supersedeVerified(pharmacyId: string, at: Date, tx?: unknown): Promise<boolean> {
    const { count } = await this.client(tx).payoutBeneficiary.updateMany({
      where: { pharmacyId, status: PayoutBeneficiaryStatus.VERIFIED },
      data: { status: PayoutBeneficiaryStatus.SUPERSEDED, supersededAt: at },
    });
    return count > 0;
  }

  async verifyBeneficiary(
    id: string,
    change: { verifiedByUserId: string; verifiedAt: Date; payableFrom: Date },
    tx?: unknown,
  ): Promise<PayoutBeneficiaryProps | null> {
    const client = this.client(tx);
    const { count } = await client.payoutBeneficiary.updateMany({
      where: { id, status: PayoutBeneficiaryStatus.PENDING_VERIFICATION },
      data: { status: PayoutBeneficiaryStatus.VERIFIED, ...change },
    });
    if (count === 0) return null;
    return this.findBeneficiary(id, tx);
  }

  async insertAttempt(
    a: Parameters<IPayoutRepository['insertAttempt']>[0],
    tx?: unknown,
  ): Promise<PayoutAttemptProps | null> {
    try {
      const row = await this.client(tx).payoutAttempt.create({
        data: {
          id: a.id,
          settlementId: a.settlementId,
          beneficiaryId: a.beneficiaryId,
          idempotencyKey: a.idempotencyKey,
          reference: a.reference,
          providerKey: a.providerKey,
          amount: a.amount,
          currency: a.currency,
          initiatedByUserId: a.initiatedByUserId,
        },
      });
      return toAttempt(row);
    } catch (err) {
      if (isUnique(err)) return null;
      throw err;
    }
  }

  async findAttemptByKey(idempotencyKey: string, tx?: unknown): Promise<PayoutAttemptProps | null> {
    const row = await this.client(tx).payoutAttempt.findUnique({ where: { idempotencyKey } });
    return row ? toAttempt(row) : null;
  }

  async findOpenAttempt(settlementId: string, tx?: unknown): Promise<PayoutAttemptProps | null> {
    const row = await this.client(tx).payoutAttempt.findFirst({
      where: { settlementId, status: { in: OPEN_ATTEMPT } },
    });
    return row ? toAttempt(row) : null;
  }

  async listAttempts(settlementId: string, tx?: unknown): Promise<PayoutAttemptProps[]> {
    const rows = await this.client(tx).payoutAttempt.findMany({
      where: { settlementId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toAttempt);
  }

  async resolveAttempt(
    id: string,
    change: {
      status: PayoutAttemptStatus;
      providerReference?: string | null;
      failureReason?: string | null;
      completedAt?: Date | null;
    },
    tx?: unknown,
  ): Promise<PayoutAttemptProps | null> {
    const client = this.client(tx);
    const { count } = await client.payoutAttempt.updateMany({
      where: { id, status: { in: OPEN_ATTEMPT } },
      data: change,
    });
    if (count === 0) return null;
    const row = await client.payoutAttempt.findUnique({ where: { id } });
    return row ? toAttempt(row) : null;
  }

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }
}

function isUnique(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function toBeneficiary(row: PayoutBeneficiary): PayoutBeneficiaryProps {
  return {
    id: row.id,
    pharmacyId: row.pharmacyId,
    rail: row.rail,
    accountName: row.accountName,
    bankCode: row.bankCode,
    accountIdentifierEncrypted: row.accountIdentifierEncrypted,
    accountIdentifierLast4: row.accountIdentifierLast4,
    status: row.status,
    createdByUserId: row.createdByUserId,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    payableFrom: row.payableFrom,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
  };
}

function toAttempt(row: PayoutAttempt): PayoutAttemptProps {
  return {
    id: row.id,
    settlementId: row.settlementId,
    beneficiaryId: row.beneficiaryId,
    idempotencyKey: row.idempotencyKey,
    reference: row.reference,
    providerKey: row.providerKey,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    providerReference: row.providerReference,
    failureReason: row.failureReason,
    initiatedByUserId: row.initiatedByUserId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}
