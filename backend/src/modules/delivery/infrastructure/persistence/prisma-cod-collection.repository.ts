import { Injectable } from '@nestjs/common';
import {
  CodCollection as PrismaCodCollection,
  CodCorrection as PrismaCodCorrection,
  CodDispute as PrismaCodDispute,
  CodReconciliation as PrismaCodReconciliation,
  CodRemittance as PrismaCodRemittance,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CodCollectionProps } from '../../domain/entities/cod-collection.entity';
import { CodCorrectionProps } from '../../domain/entities/cod-correction.entity';
import { CodDisputeProps } from '../../domain/entities/cod-dispute.entity';
import { CodReconciliationProps } from '../../domain/entities/cod-reconciliation.entity';
import { CodRemittanceProps } from '../../domain/entities/cod-remittance.entity';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodReconciliationOutcome,
} from '../../domain/enums';
import {
  CodCollectionPage,
  CodCollectionRecord,
  CodCollectionSearchCriteria,
  CodCollectionSummary,
  CodCollectionSummaryCriteria,
  CodDisputePage,
  CodDisputeSearchCriteria,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';

/**
 * `ICodCollectionRepository` over Prisma (§8's `cod_collections`).
 *
 * ## Append-only in the code as well as in the contract
 *
 * There is no `delete` and no `upsert` anywhere in this file, and the only `updateMany` is the pair
 * of **status compare-and-sets** below — which write three columns between them (`status`, and one
 * of `remittedAt`/`reconciledAt`) and touch no amount, no reference and no actor. Every fact the
 * remittance work records lands as an insert into `cod_remittances` or `cod_reconciliations`; a
 * driver's declaration about how much of a customer's money they are holding is never rewritten by
 * anything that happens to it afterwards.
 *
 * The compare-and-set is deliberately expressed as `updateMany` with the expected status in the
 * `where` clause rather than `update` by id: Prisma's `update` would happily write regardless of
 * status, and the row count coming back as `0` is what makes "somebody else got here first" a
 * value this module can act on instead of a race it has to guess at.
 *
 * ## The unique index does the deduplication
 *
 * `insert` catches Prisma's `P2002` on `cod_collections.jobId` and returns `null` rather than
 * throwing, because a collision is an expected outcome: a handset at a doorstep on a bad connection
 * retries, and two API nodes can reach this insert simultaneously.
 *
 * **It does not re-read the winner here**, and that is the important part. A unique violation puts
 * the enclosing Postgres transaction into an aborted state, so a query issued on the same
 * connection immediately afterwards fails — the defect the proof-of-delivery work found against a
 * real database. The caller unwinds the transaction first and reads on a fresh connection.
 */
@Injectable()
export class PrismaCodCollectionRepository implements ICodCollectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Prisma.TransactionClient | PrismaService {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async insert(
    collection: CodCollectionProps,
    tx?: unknown,
  ): Promise<CodCollectionProps | null> {
    try {
      const row = await this.client(tx).codCollection.create({
        data: {
          id: collection.id,
          jobId: collection.jobId,
          orderId: collection.orderId,
          fulfillmentId: collection.fulfillmentId,
          driverId: collection.driverId,
          expectedAmount: collection.expectedAmount,
          collectedAmount: collection.collectedAmount,
          currency: collection.currency,
          method: collection.method,
          status: collection.status,
          providerReference: collection.providerReference,
          collectedAt: collection.collectedAt,
          recordedAt: collection.recordedAt,
          // Written as `null` rather than omitted, so the row states outright that the money has
          // neither reached PharmaLink nor been verified. Delivery never sets any of the three.
          remittedAt: collection.remittedAt,
          reconciledAt: collection.reconciledAt,
          settlementRef: collection.settlementRef,
        },
      });
      return toProps(row);
    } catch (err) {
      if (isJobUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }

  async findByJobId(jobId: string, tx?: unknown): Promise<CodCollectionProps | null> {
    const row = await this.client(tx).codCollection.findUnique({ where: { jobId } });
    return row ? toProps(row) : null;
  }

  async findById(collectionId: string, tx?: unknown): Promise<CodCollectionProps | null> {
    const row = await this.client(tx).codCollection.findUnique({ where: { id: collectionId } });
    return row ? toProps(row) : null;
  }

  async advanceToRemitted(
    collectionId: string,
    remittedAt: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const { count } = await this.client(tx).codCollection.updateMany({
      // The expectation, not just the target. A collection another operator remitted a
      // millisecond ago no longer matches, so this writes nothing and reports the loss.
      where: { id: collectionId, status: CodCollectionStatus.COLLECTED },
      data: { status: CodCollectionStatus.REMITTED, remittedAt },
    });
    return count === 1;
  }

  async advanceToReconciled(
    collectionId: string,
    reconciledAt: Date,
    tx?: unknown,
  ): Promise<boolean> {
    const { count } = await this.client(tx).codCollection.updateMany({
      // `REMITTED` specifically — never "anything but RECONCILED". That is what keeps
      // `COLLECTED → RECONCILED` unreachable at the storage layer, and what makes the transition
      // one-way: a second attempt finds `RECONCILED`, matches nothing and cannot move it back.
      where: { id: collectionId, status: CodCollectionStatus.REMITTED },
      data: { status: CodCollectionStatus.RECONCILED, reconciledAt },
    });
    return count === 1;
  }

  async insertRemittance(
    remittance: CodRemittanceProps,
    tx?: unknown,
  ): Promise<CodRemittanceProps | null> {
    try {
      const row = await this.client(tx).codRemittance.create({
        data: {
          id: remittance.id,
          collectionId: remittance.collectionId,
          remittedAmount: remittance.remittedAmount,
          currency: remittance.currency,
          reference: remittance.reference,
          note: remittance.note,
          confirmedByUserId: remittance.confirmedByUserId,
          remittedAt: remittance.remittedAt,
          recordedAt: remittance.recordedAt,
        },
      });
      return toRemittanceProps(row);
    } catch (err) {
      if (isCollectionUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }

  async findRemittanceByCollectionId(
    collectionId: string,
    tx?: unknown,
  ): Promise<CodRemittanceProps | null> {
    const row = await this.client(tx).codRemittance.findUnique({ where: { collectionId } });
    return row ? toRemittanceProps(row) : null;
  }

  async insertReconciliation(
    reconciliation: CodReconciliationProps,
    tx?: unknown,
  ): Promise<CodReconciliationProps | null> {
    try {
      const row = await this.client(tx).codReconciliation.create({
        data: {
          id: reconciliation.id,
          collectionId: reconciliation.collectionId,
          outcome: reconciliation.outcome,
          reference: reconciliation.reference,
          note: reconciliation.note,
          reconciledByUserId: reconciliation.reconciledByUserId,
          reconciledAt: reconciliation.reconciledAt,
        },
      });
      return toReconciliationProps(row);
    } catch (err) {
      if (isCollectionUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }

  async findReconciliationByCollectionId(
    collectionId: string,
    tx?: unknown,
  ): Promise<CodReconciliationProps | null> {
    const row = await this.client(tx).codReconciliation.findUnique({ where: { collectionId } });
    return row ? toReconciliationProps(row) : null;
  }

  async findRecordById(collectionId: string, tx?: unknown): Promise<CodCollectionRecord | null> {
    const row = await this.client(tx).codCollection.findUnique({
      where: { id: collectionId },
      include: {
        remittance: true,
        reconciliation: true,
        corrections: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        disputes: { orderBy: [{ openedAt: 'desc' }, { id: 'desc' }] },
      },
    });
    return row ? toRecord(row) : null;
  }

  /**
   * The finance list (§18, §19).
   *
   * One `where` built from the filters the caller supplied and nothing else — an absent filter is
   * an absent clause, never a default that quietly narrows the answer. `remittanceReference` is the
   * only one that reaches through a relation, and it is an exact match rather than a prefix or a
   * contains: a handover handle either names this batch or it does not, and a `contains` here would
   * turn one operator's reference into a substring search across every other operator's.
   *
   * Ordered by `collectedAt` descending with `id` as the tiebreak, so a page boundary cannot drop
   * or repeat a row when two collections share a timestamp — which they will, because a day's
   * seeding and a day's deliveries both cluster.
   */
  async insertCorrection(
    correction: CodCorrectionProps,
    tx?: unknown,
  ): Promise<CodCorrectionProps | null> {
    try {
      const row = await this.client(tx).codCorrection.create({
        data: {
          id: correction.id,
          collectionId: correction.collectionId,
          remittanceId: correction.remittanceId,
          reconciliationId: correction.reconciliationId,
          type: correction.type,
          originalAmount: correction.originalAmount,
          correctedAmount: correction.correctedAmount,
          originalReference: correction.originalReference,
          correctedReference: correction.correctedReference,
          reason: correction.reason,
          idempotencyKey: correction.idempotencyKey,
          createdByUserId: correction.createdByUserId,
          createdAt: correction.createdAt,
        },
      });
      return toCorrectionProps(row);
    } catch (err) {
      if (isUniqueViolationOn(err, 'idempotencyKey')) {
        return null;
      }
      throw err;
    }
  }

  async findCorrectionByIdempotencyKey(
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<CodCorrectionProps | null> {
    const row = await this.client(tx).codCorrection.findUnique({ where: { idempotencyKey } });
    return row ? toCorrectionProps(row) : null;
  }

  async listCorrections(collectionId: string, tx?: unknown): Promise<CodCorrectionProps[]> {
    const rows = await this.client(tx).codCorrection.findMany({
      where: { collectionId },
      // Oldest first: a correction trail is read forwards, and a later correction of an earlier
      // correction only makes sense in the order the operators wrote them.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toCorrectionProps);
  }

  async insertDispute(dispute: CodDisputeProps, tx?: unknown): Promise<CodDisputeProps | null> {
    try {
      const row = await this.client(tx).codDispute.create({
        data: {
          id: dispute.id,
          collectionId: dispute.collectionId,
          reason: dispute.reason,
          status: dispute.status,
          openedByUserId: dispute.openedByUserId,
          openedAt: dispute.openedAt,
          resolvedByUserId: dispute.resolvedByUserId,
          resolvedAt: dispute.resolvedAt,
          resolutionNote: dispute.resolutionNote,
        },
      });
      return toDisputeProps(row);
    } catch (err) {
      // The **partial** index `cod_disputes(collectionId) WHERE status = 'OPEN'`, which Prisma
      // reports by its *column* rather than by its name — the schema file cannot describe a partial
      // index, but Postgres still names the offending field. Matching the column is exact enough
      // here because `cod_disputes` has exactly one unique index and this is it; a collision on
      // anything else would be a genuine defect and is rethrown.
      if (isUniqueViolationOn(err, 'collectionId')) {
        return null;
      }
      throw err;
    }
  }

  async searchDisputes(
    criteria: CodDisputeSearchCriteria,
    page: number,
    size: number,
    tx?: unknown,
  ): Promise<CodDisputePage> {
    const where: Prisma.CodDisputeWhereInput = {
      ...(criteria.status && { status: criteria.status }),
      ...(criteria.collectionId && { collectionId: criteria.collectionId }),
      ...((criteria.openedFrom || criteria.openedTo) && {
        openedAt: {
          ...(criteria.openedFrom && { gte: criteria.openedFrom }),
          ...(criteria.openedTo && { lt: criteria.openedTo }),
        },
      }),
      ...((criteria.resolvedFrom || criteria.resolvedTo) && {
        resolvedAt: {
          ...(criteria.resolvedFrom && { gte: criteria.resolvedFrom }),
          ...(criteria.resolvedTo && { lt: criteria.resolvedTo }),
        },
      }),
      ...((criteria.driverId || criteria.jobId || criteria.orderId) && {
        collection: {
          ...(criteria.driverId && { driverId: criteria.driverId }),
          ...(criteria.jobId && { jobId: criteria.jobId }),
          ...(criteria.orderId && { orderId: criteria.orderId }),
        },
      }),
    };
    const client = this.client(tx);
    const [rows, total] = await Promise.all([
      client.codDispute.findMany({
        where,
        include: { collection: true },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      client.codDispute.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({ dispute: toDisputeProps(row), collection: toProps(row.collection) })),
      total,
      page,
      size,
    };
  }

  async findDisputeById(disputeId: string, tx?: unknown): Promise<CodDisputeProps | null> {
    const row = await this.client(tx).codDispute.findUnique({ where: { id: disputeId } });
    return row ? toDisputeProps(row) : null;
  }

  async findOpenDispute(collectionId: string, tx?: unknown): Promise<CodDisputeProps | null> {
    const row = await this.client(tx).codDispute.findFirst({
      where: { collectionId, status: CodDisputeStatus.OPEN },
    });
    return row ? toDisputeProps(row) : null;
  }

  async listDisputes(collectionId: string, tx?: unknown): Promise<CodDisputeProps[]> {
    const rows = await this.client(tx).codDispute.findMany({
      where: { collectionId },
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toDisputeProps);
  }

  async resolveDispute(
    disputeId: string,
    resolution: { resolvedByUserId: string; resolvedAt: Date; resolutionNote: string | null },
    tx?: unknown,
  ): Promise<boolean> {
    const { count } = await this.client(tx).codDispute.updateMany({
      // The expectation, not just the target. A dispute another operator closed a millisecond ago
      // no longer matches, so this writes nothing and their conclusion stands.
      where: { id: disputeId, status: CodDisputeStatus.OPEN },
      data: {
        status: CodDisputeStatus.RESOLVED,
        resolvedByUserId: resolution.resolvedByUserId,
        resolvedAt: resolution.resolvedAt,
        resolutionNote: resolution.resolutionNote,
      },
    });
    return count === 1;
  }

  async search(criteria: CodCollectionSearchCriteria): Promise<CodCollectionPage> {
    const where = codCollectionWhere(criteria);

    const [rows, total] = await Promise.all([
      this.prisma.codCollection.findMany({
        where,
        include: {
          remittance: true,
          reconciliation: true,
          corrections: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          disputes: { orderBy: [{ openedAt: 'desc' }, { id: 'desc' }] },
        },
        orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      this.prisma.codCollection.count({ where }),
    ]);

    return {
      items: rows.map(toRecord),
      total,
      page: criteria.page,
      size: criteria.size,
    };
  }

  /**
   * Counts and sums over exactly the population `search` would page.
   *
   * One raw statement rather than several `aggregate` calls, because two of the seven figures are
   * **column comparisons** — "declared differs from expected", "remitted differs from declared" —
   * which no ORM filter can express, and splitting the rest across separate round trips would mean
   * the totals and the discrepancy count could observe different snapshots of a table that
   * operators are writing to while they read it. A single statement is one snapshot.
   *
   * `FILTER (WHERE ...)` does the subsetting, so `outstanding` and `discrepancy` are computed from
   * the same scan as the totals rather than from repeated ones. The predicates mirror
   * `isOutstanding` and `hasDiscrepancy` on the item view exactly: a reader who filters the list by
   * either gets a count that agrees with what they are looking at.
   *
   * `COALESCE` around every sum: `SUM` over no rows is `NULL` in SQL, and no rows summed is zero
   * money. Counts come back as `bigint` and are narrowed with `Number` — a COD collection count
   * cannot approach 2^53.
   */
  async summarize(criteria: CodCollectionSummaryCriteria): Promise<CodCollectionSummary> {
    const filters: Prisma.Sql[] = [];
    if (criteria.driverId) {
      filters.push(Prisma.sql`c."driverId" = ${criteria.driverId}`);
    }
    if (criteria.status) {
      filters.push(Prisma.sql`c."status" = ${criteria.status}::"CodCollectionStatus"`);
    }
    if (criteria.currency) {
      filters.push(Prisma.sql`c."currency" = ${criteria.currency}`);
    }
    if (criteria.orderId) {
      filters.push(Prisma.sql`c."orderId" = ${criteria.orderId}`);
    }
    if (criteria.remittanceReference) {
      filters.push(Prisma.sql`r."reference" = ${criteria.remittanceReference}`);
    }
    if (criteria.from) {
      filters.push(Prisma.sql`c."collectedAt" >= ${criteria.from}`);
    }
    if (criteria.to) {
      filters.push(Prisma.sql`c."collectedAt" <= ${criteria.to}`);
    }
    const where =
      filters.length === 0
        ? Prisma.empty
        : Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        count: bigint;
        expected: bigint;
        collected: bigint;
        remitted: bigint;
        outstandingCount: bigint;
        outstandingAmount: bigint;
        discrepancyCount: bigint;
      }>
    >`
      SELECT
        COUNT(*)::bigint AS "count",
        COALESCE(SUM(c."expectedAmount"), 0)::bigint AS "expected",
        COALESCE(SUM(c."collectedAmount"), 0)::bigint AS "collected",
        COALESCE(SUM(r."remittedAmount"), 0)::bigint AS "remitted",
        COUNT(*) FILTER (
          WHERE c."status" <> 'RECONCILED'::"CodCollectionStatus"
        )::bigint AS "outstandingCount",
        COALESCE(SUM(c."collectedAmount") FILTER (
          WHERE c."status" <> 'RECONCILED'::"CodCollectionStatus"
        ), 0)::bigint AS "outstandingAmount",
        COUNT(*) FILTER (
          WHERE c."collectedAmount" <> c."expectedAmount"
             OR (r."id" IS NOT NULL AND r."remittedAmount" <> c."collectedAmount")
        )::bigint AS "discrepancyCount"
      FROM "cod_collections" c
      LEFT JOIN "cod_remittances" r ON r."collectionId" = c."id"
      ${where}
    `;

    const row = rows[0];
    return {
      count: Number(row?.count ?? 0n),
      expectedAmount: Number(row?.expected ?? 0n),
      collectedAmount: Number(row?.collected ?? 0n),
      remittedAmount: Number(row?.remitted ?? 0n),
      outstandingCount: Number(row?.outstandingCount ?? 0n),
      outstandingAmount: Number(row?.outstandingAmount ?? 0n),
      discrepancyCount: Number(row?.discrepancyCount ?? 0n),
    };
  }
}

/**
 * Whether this is the `cod_collections.jobId` unique violation specifically.
 *
 * Narrowed to the one constraint rather than accepting any `P2002`: a collision on some other
 * unique index would be a genuine defect, and swallowing it as "already collected" would hide it
 * behind a successful-looking response — and behind a driver believing their submission landed.
 */
function isJobUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('jobId'));
}

/**
 * Whether this is a `collectionId` unique violation on one of the two child tables.
 *
 * Narrowed to that column for the reason `isJobUniqueViolation` is narrowed to `jobId`: a collision
 * on some other index would be a genuine defect, and swallowing it as "already remitted" would hide
 * it behind a successful-looking response — and behind an operator believing the platform had
 * recorded receiving cash it had not.
 */
/**
 * Whether this is a `P2002` naming one specific constraint or column.
 *
 * Narrowed the same way `isJobUniqueViolation` and `isCollectionUniqueViolation` are, and for the
 * same reason: a collision on some *other* index is a genuine defect, and swallowing it as "already
 * recorded" would hide it behind a successful-looking response — and behind an operator believing a
 * correction had been filed that had not.
 */
function isUniqueViolationOn(err: unknown, target: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const meta = err.meta ?? {};
  const raw = (meta as { target?: unknown }).target;
  const fields = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
  // A partial index that Prisma cannot name by column surfaces in the message instead.
  return fields.some((field) => field.includes(target)) || err.message.includes(target);
}

function isCollectionUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('collectionId'));
}

function toRecord(
  row: PrismaCodCollection & {
    remittance: PrismaCodRemittance | null;
    reconciliation: PrismaCodReconciliation | null;
    corrections?: PrismaCodCorrection[];
    disputes?: PrismaCodDispute[];
  },
): CodCollectionRecord {
  return {
    collection: toProps(row),
    remittance: row.remittance ? toRemittanceProps(row.remittance) : null,
    reconciliation: row.reconciliation ? toReconciliationProps(row.reconciliation) : null,
    corrections: (row.corrections ?? []).map(toCorrectionProps),
    disputes: (row.disputes ?? []).map(toDisputeProps),
  };
}

function toCorrectionProps(row: PrismaCodCorrection): CodCorrectionProps {
  return {
    id: row.id,
    collectionId: row.collectionId,
    remittanceId: row.remittanceId,
    reconciliationId: row.reconciliationId,
    type: row.type as CodCorrectionType,
    originalAmount: row.originalAmount,
    correctedAmount: row.correctedAmount,
    originalReference: row.originalReference,
    correctedReference: row.correctedReference,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function toDisputeProps(row: PrismaCodDispute): CodDisputeProps {
  return {
    id: row.id,
    collectionId: row.collectionId,
    reason: row.reason,
    status: row.status as CodDisputeStatus,
    openedByUserId: row.openedByUserId,
    openedAt: row.openedAt,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
  };
}

function toRemittanceProps(row: PrismaCodRemittance): CodRemittanceProps {
  return {
    id: row.id,
    collectionId: row.collectionId,
    remittedAmount: row.remittedAmount,
    currency: row.currency,
    reference: row.reference,
    note: row.note,
    confirmedByUserId: row.confirmedByUserId,
    remittedAt: row.remittedAt,
    recordedAt: row.recordedAt,
  };
}

function toReconciliationProps(row: PrismaCodReconciliation): CodReconciliationProps {
  return {
    id: row.id,
    collectionId: row.collectionId,
    outcome: row.outcome as CodReconciliationOutcome,
    reference: row.reference,
    note: row.note,
    reconciledByUserId: row.reconciledByUserId,
    reconciledAt: row.reconciledAt,
  };
}


/**
 * The `where` clause shared by `search` and the paging half of the finance read.
 *
 * Extracted rather than duplicated so that a filter can never mean one thing in the list and
 * another in the summary beside it. `summarize` builds the equivalent predicate in SQL because it
 * needs column-to-column comparisons Prisma cannot express; the two are kept honest by the e2e
 * tests that assert a summary against the page it heads.
 */
function codCollectionWhere(
  criteria: CodCollectionSummaryCriteria,
): Prisma.CodCollectionWhereInput {
  const where: Prisma.CodCollectionWhereInput = {};
  if (criteria.driverId) {
    where.driverId = criteria.driverId;
  }
  if (criteria.status) {
    where.status = criteria.status;
  }
  if (criteria.currency) {
    where.currency = criteria.currency;
  }
  if (criteria.orderId) {
    where.orderId = criteria.orderId;
  }
  if (criteria.remittanceReference) {
    where.remittance = { is: { reference: criteria.remittanceReference } };
  }
  if (criteria.from || criteria.to) {
    where.collectedAt = {
      ...(criteria.from ? { gte: criteria.from } : {}),
      ...(criteria.to ? { lte: criteria.to } : {}),
    };
  }
  return where;
}

function toProps(row: PrismaCodCollection): CodCollectionProps {
  return {
    id: row.id,
    jobId: row.jobId,
    orderId: row.orderId,
    fulfillmentId: row.fulfillmentId,
    driverId: row.driverId,
    expectedAmount: row.expectedAmount,
    collectedAmount: row.collectedAmount,
    currency: row.currency,
    method: row.method as CodCollectionMethod,
    status: row.status as CodCollectionStatus,
    providerReference: row.providerReference,
    collectedAt: row.collectedAt,
    recordedAt: row.recordedAt,
    remittedAt: row.remittedAt,
    reconciledAt: row.reconciledAt,
    settlementRef: row.settlementRef,
  };
}
