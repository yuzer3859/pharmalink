import { Injectable } from '@nestjs/common';
import {
  Prisma,
  PayoutLine as PrismaPayoutLine,
  Settlement as PrismaSettlement,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  SettlementLineProps,
  SettlementProps,
  SettlementWithLines,
} from '../../domain/entities/settlement.entity';
import {
  ISettlementRepository,
  ListSettlementsCriteria,
  SettlementIdentity,
  SettlementPage,
  SettlementStatusTotals,
} from '../../domain/repositories/settlement.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toSettlementProps(row: PrismaSettlement): SettlementProps {
  return {
    id: row.id,
    pharmacyId: row.pharmacyId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    currency: row.currency,
    providerPayableGross: row.grossAmount,
    refundClawback: row.refundClawback,
    netPayable: row.netAmount,
    platformRevenue: row.platformFeeTotal,
    promotionExpense: row.promotionExpense,
    customerCashCollected: row.customerCashCollected,
    lineCount: row.lineCount,
    status: row.status,
    // The column is nullable from the Phase-0 schema; the domain always writes one, so an empty
    // value can only mean a row written before this task existed.
    statementRef: row.statementRef ?? '',
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

function toLineProps(row: PrismaPayoutLine): SettlementLineProps {
  return {
    id: row.id,
    settlementId: row.settlementId,
    ledgerTransactionId: row.ledgerTransactionId,
    ledgerReference: row.ledgerReference,
    transactionType: row.transactionType,
    sourceRefType: row.sourceRefType,
    sourceRefId: row.sourceRefId,
    orderId: row.orderId,
    occurredAt: row.occurredAt,
    currency: row.currency,
    providerPayableDelta: row.providerPayableDelta,
    platformRevenueDelta: row.platformRevenueDelta,
    promotionExpenseDelta: row.promotionExpenseDelta,
    customerCashDelta: row.customerCashDelta,
    createdAt: row.createdAt,
  };
}

/**
 * Prisma adapter for `ISettlementRepository` (§7's `settlements` / `payout_lines`).
 *
 * **No update and no delete method, deliberately** — see the port's doc comment. A statement is a
 * report about an immutable ledger and is itself immutable; the only writes here are the initial
 * insert of a statement with its lines.
 *
 * The domain's field names differ from the columns (`providerPayableGross` ↔ `grossAmount`,
 * `platformRevenue` ↔ `platformFeeTotal`) because the Phase-0 columns were named before the
 * accounting they now carry existed. The mapping is confined to this file rather than renaming
 * columns in a migration: the domain names say what the figures *are*, and a rename would churn a
 * schema for no behavioural gain.
 */
@Injectable()
export class PrismaSettlementRepository implements ISettlementRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findByIdentity(
    identity: SettlementIdentity,
    tx?: unknown,
  ): Promise<SettlementProps | null> {
    const row = await this.client(tx).settlement.findUnique({
      where: {
        pharmacyId_periodStart_periodEnd_currency: {
          pharmacyId: identity.pharmacyId,
          periodStart: identity.periodStart,
          periodEnd: identity.periodEnd,
          currency: identity.currency,
        },
      },
    });
    return row ? toSettlementProps(row) : null;
  }

  async findById(id: string, tx?: unknown): Promise<SettlementProps | null> {
    const row = await this.client(tx).settlement.findUnique({ where: { id } });
    return row ? toSettlementProps(row) : null;
  }

  async findWithLines(id: string, tx?: unknown): Promise<SettlementWithLines | null> {
    const row = await this.client(tx).settlement.findUnique({
      where: { id },
      include: { payoutLines: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!row) {
      return null;
    }
    return {
      settlement: toSettlementProps(row),
      lines: row.payoutLines.map(toLineProps),
    };
  }

  async list(criteria: ListSettlementsCriteria, tx?: unknown): Promise<SettlementPage> {
    // `undefined` is the only thing that leaves `pharmacyId` unconstrained. An empty array is
    // passed through as `in: []`, which matches no row — see the criteria's doc comment for why
    // the two must not be collapsed.
    const where: Prisma.SettlementWhereInput = {
      ...(criteria.pharmacyIds === undefined
        ? {}
        : { pharmacyId: { in: criteria.pharmacyIds } }),
      ...(criteria.from ? { periodStart: { gte: criteria.from } } : {}),
      ...(criteria.to ? { periodEnd: { lte: criteria.to } } : {}),
      ...(criteria.currency ? { currency: criteria.currency } : {}),
      ...(criteria.status ? { status: criteria.status } : {}),
    };
    const client = this.client(tx);
    const [rows, total] = await Promise.all([
      client.settlement.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { id: 'asc' }],
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      client.settlement.count({ where }),
    ]);
    return { items: rows.map(toSettlementProps), total };
  }

  /**
   * Writes the statement and its lines together.
   *
   * When the caller supplies a `tx` the two writes join it; when it does not, they are wrapped in
   * one transaction here rather than issued loose. A statement whose lines are missing would
   * report totals nothing substantiates — and because there is no update method, it could never be
   * completed afterwards.
   */
  async create(
    settlement: SettlementProps,
    lines: SettlementLineProps[],
    tx?: unknown,
  ): Promise<SettlementWithLines> {
    const write = async (client: Client): Promise<SettlementWithLines> => {
      await client.settlement.create({
        data: {
          id: settlement.id,
          pharmacyId: settlement.pharmacyId,
          periodStart: settlement.periodStart,
          periodEnd: settlement.periodEnd,
          currency: settlement.currency,
          grossAmount: settlement.providerPayableGross,
          platformFeeTotal: settlement.platformRevenue,
          promotionExpense: settlement.promotionExpense,
          customerCashCollected: settlement.customerCashCollected,
          refundClawback: settlement.refundClawback,
          netAmount: settlement.netPayable,
          lineCount: settlement.lineCount,
          status: settlement.status,
          statementRef: settlement.statementRef,
          paidAt: settlement.paidAt,
          createdAt: settlement.createdAt,
        },
      });

      if (lines.length > 0) {
        await client.payoutLine.createMany({
          data: lines.map((line) => ({
            id: line.id,
            settlementId: line.settlementId,
            ledgerTransactionId: line.ledgerTransactionId,
            ledgerReference: line.ledgerReference,
            transactionType: line.transactionType,
            sourceRefType: line.sourceRefType,
            sourceRefId: line.sourceRefId,
            orderId: line.orderId,
            occurredAt: line.occurredAt,
            currency: line.currency,
            providerPayableDelta: line.providerPayableDelta,
            platformRevenueDelta: line.platformRevenueDelta,
            promotionExpenseDelta: line.promotionExpenseDelta,
            customerCashDelta: line.customerCashDelta,
            createdAt: line.createdAt,
          })),
        });
      }

      return { settlement, lines };
    };

    return tx
      ? write(this.client(tx))
      : this.prisma.$transaction((client) => write(client), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
  }

  async findOverlapping(
    pharmacyId: string,
    currency: string,
    from: Date,
    to: Date,
    tx?: unknown,
  ): Promise<SettlementProps[]> {
    // Half-open overlap: two periods overlap iff each starts before the other ends. Equal
    // boundaries are therefore *not* an overlap, which is exactly what makes consecutive
    // statements legal while a re-cut period that swallows part of an earlier one is caught.
    const rows = await this.client(tx).settlement.findMany({
      where: {
        pharmacyId,
        currency,
        periodStart: { lt: to },
        periodEnd: { gt: from },
      },
      orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toSettlementProps);
  }

  async findLines(settlementId: string, tx?: unknown): Promise<SettlementLineProps[]> {
    const rows = await this.client(tx).payoutLine.findMany({
      where: { settlementId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toLineProps);
  }

  async summarizeByStatus(tx?: unknown): Promise<SettlementStatusTotals[]> {
    const groups = await this.client(tx).settlement.groupBy({
      by: ['currency', 'status'],
      _count: { _all: true },
      _sum: {
        grossAmount: true,
        refundClawback: true,
        netAmount: true,
        platformFeeTotal: true,
        promotionExpense: true,
        customerCashCollected: true,
      },
      orderBy: [{ currency: 'asc' }, { status: 'asc' }],
    });
    // The same column-to-figure mapping `toSettlementProps` applies, summed.
    return groups.map((group) => ({
      currency: group.currency,
      status: group.status,
      count: group._count._all,
      providerPayableGross: group._sum.grossAmount ?? 0,
      refundClawback: group._sum.refundClawback ?? 0,
      netPayable: group._sum.netAmount ?? 0,
      platformRevenue: group._sum.platformFeeTotal ?? 0,
      promotionExpense: group._sum.promotionExpense ?? 0,
      customerCashCollected: group._sum.customerCashCollected ?? 0,
    }));
  }
}
