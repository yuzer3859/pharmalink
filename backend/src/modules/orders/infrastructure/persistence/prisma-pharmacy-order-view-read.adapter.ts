import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPharmacyOrderViewReadPort,
  PharmacyOrderPrescriptionView,
  PharmacyOrderView,
  PharmacyOrderViewCriteria,
} from '../../application/ports/inbound/pharmacy-order-view-read.port';

const INCLUDE = {
  order: {
    select: {
      orderNumber: true,
      status: true,
      isCod: true,
      grandTotal: true,
      currency: true,
      placedAt: true,
      deliverySlot: true,
      customerUserId: true,
      prescriptionId: true,
      rxReviewStatus: true,
      paperRxRequired: true,
      paperRxVerifiedAt: true,
    },
  },
  lines: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.FulfillmentInclude;

type Row = Prisma.FulfillmentGetPayload<{ include: typeof INCLUDE }>;

interface Related {
  /** Work 136: the paper job's state, per fulfilment. */
  paperJobs: Map<string, { paperCollectedAt: Date | null; status: string }>;
  names: Map<string, string | null>;
  prescriptions: Map<string, PharmacyOrderPrescriptionView>;
}

/**
 * Work 107: the pharmacy portal's order read. The visibility rule is the fulfilment list's own
 * (Work 95): a prepaid order is the pharmacy's to see only once its payment is recorded. Work 129:
 * an order with a prescription is visible from placement, because its pharmacist reviews the
 * prescription before the customer pays.
 *
 * The customer's name and the prescription summary are read from Module 02's and Module 05's
 * tables by id, read-only, two queries per page (no relation across modules).
 */
@Injectable()
export class PrismaPharmacyOrderViewReadAdapter implements IPharmacyOrderViewReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async list(criteria: PharmacyOrderViewCriteria): Promise<{ items: PharmacyOrderView[]; total: number }> {
    const where = visible(criteria.pharmacyIds, { status: criteria.status });
    const [rows, total] = await Promise.all([
      this.prisma.fulfillment.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      this.prisma.fulfillment.count({ where }),
    ]);
    const related = await this.related(rows);
    return { items: rows.map((row) => toView(row, related)), total };
  }

  async findById(fulfillmentId: string, pharmacyIds: string[]): Promise<PharmacyOrderView | null> {
    const row = await this.prisma.fulfillment.findFirst({ where: visible(pharmacyIds, { id: fulfillmentId }), include: INCLUDE });
    return row ? toView(row, await this.related([row])) : null;
  }

  private async related(rows: Row[]): Promise<Related> {
    const userIds = [...new Set(rows.map((r) => r.order.customerUserId))];
    const prescriptionIds = [...new Set(rows.map((r) => r.order.prescriptionId).filter((id): id is string => id !== null))];
    const paperFulfillmentIds = rows.filter((r) => r.order.paperRxRequired).map((r) => r.id);
    const [profiles, prescriptions, paperJobs] = await Promise.all([
      userIds.length === 0
        ? []
        : this.prisma.customerProfile.findMany({ where: { userId: { in: userIds }, deletedAt: null }, select: { userId: true, fullName: true } }),
      prescriptionIds.length === 0
        ? []
        : this.prisma.prescription.findMany({
            where: { id: { in: prescriptionIds } },
            select: { id: true, status: true, fileType: true, doctorName: true, hospitalName: true, createdAt: true },
          }),
      paperFulfillmentIds.length === 0
        ? []
        : this.prisma.deliveryJob.findMany({
            where: { fulfillmentId: { in: paperFulfillmentIds }, status: { notIn: ['CANCELLED', 'FAILED'] } },
            select: { fulfillmentId: true, paperCollectedAt: true, status: true },
          }),
    ]);
    return {
      paperJobs: new Map(paperJobs.map((j) => [j.fulfillmentId, { paperCollectedAt: j.paperCollectedAt, status: j.status }])),
      names: new Map(profiles.map((p) => [p.userId, p.fullName?.trim() || null])),
      prescriptions: new Map(
        prescriptions.map((p) => [
          p.id,
          { id: p.id, status: p.status, fileType: p.fileType, doctorName: p.doctorName, hospitalName: p.hospitalName, uploadedAt: p.createdAt },
        ]),
      ),
    };
  }
}

function visible(pharmacyIds: string[], extra: Prisma.FulfillmentWhereInput): Prisma.FulfillmentWhereInput {
  return {
    ...extra,
    pharmacyId: { in: pharmacyIds },
    order: { OR: [{ isCod: true }, { paymentId: { not: null } }, { prescriptionId: { not: null } }] },
  };
}

function productName(snapshot: Prisma.JsonValue | null): string | null {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const name = (snapshot as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

function toView(row: Row, related: Related): PharmacyOrderView {
  const lines = row.lines.map((l) => ({
    id: l.id,
    catalogProductId: l.catalogProductId,
    productName: productName(l.productSnapshot),
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
    requiresRx: l.requiresRx,
    lineStatus: l.lineStatus,
  }));
  const { customerUserId, prescriptionId, paperRxRequired, paperRxVerifiedAt, ...order } = row.order;
  const paperJob = related.paperJobs.get(row.id);
  return {
    id: row.id,
    orderId: row.orderId,
    pharmacyId: row.pharmacyId,
    branchId: row.branchId,
    status: row.status,
    deliveryJobId: row.deliveryJobId,
    acceptedAt: row.acceptedAt,
    readyAt: row.readyAt,
    createdAt: row.createdAt,
    order,
    lines,
    requiresRx: lines.some((l) => l.requiresRx),
    customerName: related.names.get(customerUserId) ?? null,
    prescription: prescriptionId ? related.prescriptions.get(prescriptionId) ?? null : null,
    paper: paperRxRequired
      ? { collectedAt: paperJob?.paperCollectedAt ?? null, driverAtPharmacy: paperJob?.status === 'ARRIVED_PICKUP', verifiedAt: paperRxVerifiedAt }
      : null,
  };
}
