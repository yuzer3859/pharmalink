import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryOperationsDetail,
  DeliveryOperationsFilter,
  DeliveryOperationsPage,
  DeliveryOperationsSummary,
  IDeliveryOperationsReadPort,
} from '../../application/ports/inbound/delivery-operations-read.port';
import { deliveryTimelineOf } from '../../application/queries/get-delivery-job-status.query';

/** The columns a summary needs — selected explicitly, so no address, coordinate or manifest is ever read. */
const SUMMARY_SELECT = {
  id: true,
  orderId: true,
  fulfillmentId: true,
  pharmacyId: true,
  branchId: true,
  status: true,
  assignedDriverId: true,
  isCod: true,
  isColdChain: true,
  etaAt: true,
  pickedUpAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeliveryJobSelect;

type SummaryRow = Prisma.DeliveryJobGetPayload<{ select: typeof SUMMARY_SELECT }>;

const toSummary = (r: SummaryRow): DeliveryOperationsSummary => ({
  deliveryJobId: r.id,
  orderId: r.orderId,
  fulfillmentId: r.fulfillmentId,
  pharmacyId: r.pharmacyId,
  branchId: r.branchId,
  status: r.status,
  driverProfileId: r.assignedDriverId,
  isCod: r.isCod,
  isColdChain: r.isColdChain,
  etaAt: r.etaAt,
  pickedUpAt: r.pickedUpAt,
  deliveredAt: r.deliveredAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * `IDeliveryOperationsReadPort` over Prisma — `SELECT`s only, with explicit column selections. The
 * list is one paged `findMany` plus one `count` in one transaction, so the page and its total agree.
 * The detail reads the job, its transitions (`toStatus` and time only — no reason, actor or position)
 * and its COD collection in one REPEATABLE READ snapshot, and derives the timeline with Module 08's
 * own `deliveryTimelineOf`.
 */
@Injectable()
export class PrismaDeliveryOperationsReadAdapter implements IDeliveryOperationsReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listJobs(f: DeliveryOperationsFilter, page: number, size: number): Promise<DeliveryOperationsPage> {
    const where: Prisma.DeliveryJobWhereInput = {
      ...(f.status ? { status: f.status } : {}),
      ...(f.orderId ? { orderId: f.orderId } : {}),
      ...(f.isCod !== undefined ? { isCod: f.isCod } : {}),
      ...(f.createdFrom || f.createdTo
        ? { createdAt: { ...(f.createdFrom ? { gte: f.createdFrom } : {}), ...(f.createdTo ? { lt: f.createdTo } : {}) } }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.deliveryJob.findMany({
        where,
        select: SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.deliveryJob.count({ where }),
    ]);
    return { items: rows.map(toSummary), total, page, size };
  }

  async getJob(deliveryJobId: string): Promise<DeliveryOperationsDetail | null> {
    const [row, history, cod] = await this.prisma.$transaction(
      [
        this.prisma.deliveryJob.findUnique({ where: { id: deliveryJobId }, select: SUMMARY_SELECT }),
        this.prisma.deliveryStatusHistory.findMany({
          where: { jobId: deliveryJobId },
          select: { toStatus: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.codCollection.findUnique({
          where: { jobId: deliveryJobId },
          select: {
            id: true,
            status: true,
            method: true,
            expectedAmount: true,
            collectedAmount: true,
            currency: true,
            collectedAt: true,
            remittedAt: true,
            reconciledAt: true,
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!row) return null;
    return {
      ...toSummary(row),
      timeline: deliveryTimelineOf(
        row,
        history.map((h) => ({ toStatus: h.toStatus as DeliveryOperationsSummary['status'], createdAt: h.createdAt })),
      ),
      cod: cod
        ? {
            collectionId: cod.id,
            status: cod.status,
            method: cod.method,
            expectedAmount: cod.expectedAmount,
            collectedAmount: cod.collectedAmount,
            currency: cod.currency,
            collectedAt: cod.collectedAt,
            remittedAt: cod.remittedAt,
            reconciledAt: cod.reconciledAt,
          }
        : null,
    };
  }
}
