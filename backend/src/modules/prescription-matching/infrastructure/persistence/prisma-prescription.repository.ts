import { Injectable } from '@nestjs/common';
import {
  Prisma,
  Prescription as PrismaPrescription,
  PrescriptionLine as PrismaPrescriptionLine,
  PrescriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IPrescriptionRepository,
  ListPrescriptionsCriteria,
  NewPrescriptionAccessLogEntry,
  NewPrescriptionData,
  NewPrescriptionLineData,
  PagedResult,
  PrescriptionLineSnapshot,
  PrescriptionSnapshot,
  PrescriptionStatusUpdate,
  VerificationQueueCriteria,
} from '../../domain/repositories/prescription.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toPrescriptionSnapshot(row: PrismaPrescription): PrescriptionSnapshot {
  return {
    id: row.id,
    customerUserId: row.customerUserId,
    beneficiaryId: row.beneficiaryId,
    status: row.status,
    fileRef: row.fileRef,
    encryptionKeyRef: row.encryptionKeyRef,
    fileType: row.fileType,
    doctorName: row.doctorName,
    hospitalName: row.hospitalName,
    issueDate: row.issueDate,
    expiryDate: row.expiryDate,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt,
    verifyingPharmacyId: row.verifyingPharmacyId,
    rejectionReason: row.rejectionReason,
    retentionUntil: row.retentionUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLineSnapshot(row: PrismaPrescriptionLine): PrescriptionLineSnapshot {
  return {
    id: row.id,
    prescriptionId: row.prescriptionId,
    catalogProductId: row.catalogProductId,
    rawText: row.rawText,
    prescribedQuantity: row.prescribedQuantity,
    refillsAllowed: row.refillsAllowed,
    dispensedQuantity: row.dispensedQuantity,
    remainingDispensable: row.remainingDispensable,
    isSingleUse: row.isSingleUse,
    createdAt: row.createdAt,
  };
}

/**
 * Prisma adapter for `IPrescriptionRepository` (module-05 §3.1/§3.2, §11) — persists the
 * `Prescription` aggregate root and its child `PrescriptionLine` rows via `prescriptions` /
 * `prescription_lines` (`prisma/schema/05-prescription.prisma`). Follows the same `tx?: unknown`
 * pass-through convention as `PrismaAddressRepository`/`PrismaProductRepository`: every mutating
 * method uses the caller-supplied `Prisma.TransactionClient` when given, otherwise falls back to
 * the shared `PrismaService` — this adapter never opens its own transaction (the Unit of Work
 * owns the `Serializable` transaction boundary, §2.1.1/§12).
 */
@Injectable()
export class PrismaPrescriptionRepository implements IPrescriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<PrescriptionSnapshot | null> {
    const row = await this.client(tx).prescription.findUnique({ where: { id } });
    return row ? toPrescriptionSnapshot(row) : null;
  }

  async create(data: NewPrescriptionData, tx?: unknown): Promise<PrescriptionSnapshot> {
    const row = await this.client(tx).prescription.create({
      data: {
        customerUserId: data.customerUserId,
        beneficiaryId: data.beneficiaryId ?? null,
        fileRef: data.fileRef ?? null,
        encryptionKeyRef: data.encryptionKeyRef ?? null,
        fileType: data.fileType ?? null,
        doctorName: data.doctorName ?? null,
        hospitalName: data.hospitalName ?? null,
        issueDate: data.issueDate ?? null,
        expiryDate: data.expiryDate ?? null,
        retentionUntil: data.retentionUntil ?? null,
      },
    });
    return toPrescriptionSnapshot(row);
  }

  async updateStatus(id: string, update: PrescriptionStatusUpdate, tx?: unknown): Promise<void> {
    await this.client(tx).prescription.update({
      where: { id },
      data: {
        status: update.status,
        verifiedByUserId: update.verifiedByUserId,
        verifiedAt: update.verifiedAt,
        verifyingPharmacyId: update.verifyingPharmacyId,
        rejectionReason: update.rejectionReason,
        fileRef: update.fileRef,
        encryptionKeyRef: update.encryptionKeyRef,
        fileType: update.fileType,
      },
    });
  }

  async listByCustomer(
    criteria: ListPrescriptionsCriteria,
  ): Promise<PagedResult<PrescriptionSnapshot>> {
    const where: Prisma.PrescriptionWhereInput = {
      customerUserId: criteria.customerUserId,
      status: criteria.status,
    };
    const [items, total] = await Promise.all([
      this.prisma.prescription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      this.prisma.prescription.count({ where }),
    ]);
    return { items: items.map(toPrescriptionSnapshot), total };
  }

  async listVerificationQueue(
    criteria: VerificationQueueCriteria,
  ): Promise<PagedResult<PrescriptionSnapshot>> {
    const where: Prisma.PrescriptionWhereInput = {
      verifyingPharmacyId: criteria.verifyingPharmacyId,
      status: PrescriptionStatus.PENDING_VERIFICATION,
    };
    const [items, total] = await Promise.all([
      this.prisma.prescription.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      this.prisma.prescription.count({ where }),
    ]);
    return { items: items.map(toPrescriptionSnapshot), total };
  }

  async findLineById(lineId: string, tx?: unknown): Promise<PrescriptionLineSnapshot | null> {
    const row = await this.client(tx).prescriptionLine.findUnique({ where: { id: lineId } });
    return row ? toLineSnapshot(row) : null;
  }

  async findLinesByPrescriptionId(
    prescriptionId: string,
    tx?: unknown,
  ): Promise<PrescriptionLineSnapshot[]> {
    const rows = await this.client(tx).prescriptionLine.findMany({
      where: { prescriptionId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toLineSnapshot);
  }

  async createApprovedLines(
    prescriptionId: string,
    lines: NewPrescriptionLineData[],
    tx?: unknown,
  ): Promise<PrescriptionLineSnapshot[]> {
    const client = this.client(tx);
    const rows = await Promise.all(
      lines.map((line) =>
        client.prescriptionLine.create({
          data: {
            prescriptionId,
            catalogProductId: line.catalogProductId,
            rawText: line.rawText ?? null,
            prescribedQuantity: line.prescribedQuantity,
            refillsAllowed: line.refillsAllowed,
            // Derived cache starts equal to the prescribed/approved quantity (§3.2, §12) — never
            // independently settable beyond this initial value (ADR-006).
            remainingDispensable: line.prescribedQuantity,
            isSingleUse: line.isSingleUse,
          },
        }),
      ),
    );
    return rows.map(toLineSnapshot);
  }

  async updateLineDispenseState(
    lineId: string,
    dispensedQuantity: number,
    remainingDispensable: number,
    tx?: unknown,
  ): Promise<void> {
    await this.client(tx).prescriptionLine.update({
      where: { id: lineId },
      data: { dispensedQuantity, remainingDispensable },
    });
  }

  async logAccess(entry: NewPrescriptionAccessLogEntry, tx?: unknown): Promise<void> {
    await this.client(tx).prescriptionAccessLog.create({
      data: {
        prescriptionId: entry.prescriptionId,
        actorUserId: entry.actorUserId,
        role: entry.role ?? null,
        accessType: entry.accessType,
        outcome: entry.outcome,
      },
    });
  }
}
