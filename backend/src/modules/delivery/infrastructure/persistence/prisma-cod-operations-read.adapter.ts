import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CodDisputeStatus,
  CodOperationsDetail,
  CodOperationsFilter,
  CodOperationsPage,
  CodOperationsSummary,
  ICodOperationsReadPort,
} from '../../application/ports/inbound/cod-operations-read.port';
import {
  CodReconciliationView,
  ListCodCollectionsQuery,
  toCodReconciliationView,
} from '../../application/queries/list-cod-collections.query';
import { COD_COLLECTION_REPOSITORY, ICodCollectionRepository } from '../../domain/repositories/cod-collection.repository';

/**
 * `ICodOperationsReadPort` over Module 08's own COD finance read.
 *
 * The list is `ListCodCollectionsQuery.execute` — the same filters, ordering (`collectedAt` desc,
 * `id` desc), paging and projection Module 08's `GET /admin/delivery/cod-reconciliation` serves; its
 * page and total are two statements, as that route's are. The detail reads the record through
 * `ICodCollectionRepository.findRecordById` inside one REPEATABLE READ transaction, so the
 * collection, its remittance, reconciliation, corrections and disputes are one snapshot, then applies
 * the same `toCodReconciliationView`. Both reduce the view to the port's explicit fields.
 */
@Injectable()
export class PrismaCodOperationsReadAdapter implements ICodOperationsReadPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
    private readonly finance: ListCodCollectionsQuery,
  ) {}

  async listCollections(f: CodOperationsFilter, page: number, size: number): Promise<CodOperationsPage> {
    const result = await this.finance.execute({
      status: f.status,
      orderId: f.orderId,
      jobId: f.jobId,
      from: f.collectedFrom,
      to: f.collectedTo,
      page,
      size,
    });
    return { items: result.items.map(toSummary), total: result.total, page: result.page, size: result.size };
  }

  async getCollection(collectionId: string): Promise<CodOperationsDetail | null> {
    const record = await this.prisma.$transaction((tx) => this.collections.findRecordById(collectionId, tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    if (!record) return null;
    const v = toCodReconciliationView(record);
    return {
      ...toSummary(v),
      remittance: v.remittance
        ? {
            remittanceId: v.remittance.id,
            remittedAmount: v.remittance.remittedAmount,
            currency: v.remittance.currency,
            remittedAt: v.remittance.remittedAt,
            recordedAt: v.remittance.recordedAt,
          }
        : null,
      reconciliation: v.reconciliation
        ? { reconciliationId: v.reconciliation.id, outcome: v.reconciliation.outcome, reconciledAt: v.reconciliation.reconciledAt }
        : null,
      corrections: v.corrections.map((c) => ({
        correctionId: c.id,
        type: c.type,
        remittanceId: c.remittanceId,
        reconciliationId: c.reconciliationId,
        originalAmount: c.originalAmount,
        correctedAmount: c.correctedAmount,
        createdAt: c.createdAt,
      })),
      disputes: v.disputes.map((d) => ({ disputeId: d.id, status: d.status, openedAt: d.openedAt, resolvedAt: d.resolvedAt })),
    };
  }
}

function toSummary(v: CodReconciliationView): CodOperationsSummary {
  const c = v.collection;
  return {
    collectionId: c.id,
    jobId: c.jobId,
    orderId: c.orderId,
    fulfillmentId: c.fulfillmentId,
    driverProfileId: c.driverId,
    status: c.status,
    method: c.method,
    currency: c.currency,
    expectedAmount: c.expectedAmount,
    collectedAmount: c.collectedAmount,
    remittedAmount: v.remittance?.remittedAmount ?? null,
    collectionVariance: v.collectionVariance,
    remittanceVariance: v.remittanceVariance,
    hasDiscrepancy: v.hasDiscrepancy,
    isOutstanding: v.isOutstanding,
    reconciliationOutcome: v.reconciliation?.outcome ?? null,
    collectedAt: c.collectedAt,
    recordedAt: c.recordedAt,
    remittedAt: c.remittedAt,
    reconciledAt: c.reconciledAt,
    correctionCount: v.corrections.length,
    disputeCount: v.disputes.length,
    openDisputeCount: v.disputes.filter((d) => d.status === CodDisputeStatus.OPEN).length,
  };
}
