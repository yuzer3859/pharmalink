import { Injectable } from '@nestjs/common';
import { Prisma, VerificationReview as PrismaVerificationReview } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IVerificationRepository,
  NewVerificationReviewData,
  VerificationReviewSnapshot,
} from '../../domain/repositories/verification.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toDomain(row: PrismaVerificationReview): VerificationReviewSnapshot {
  return {
    id: row.id,
    prescriptionId: row.prescriptionId,
    reviewerUserId: row.reviewerUserId,
    pharmacyId: row.pharmacyId,
    decision: row.decision,
    reason: row.reason,
    legibilityOk: row.legibilityOk,
    validityOk: row.validityOk,
    reviewedAt: row.reviewedAt,
  };
}

/**
 * Prisma adapter for `IVerificationRepository` (module-05 §3.3, §11) — persists the append-only
 * `VerificationReview` trail via `verification_reviews`
 * (`prisma/schema/05-prescription.prisma`). This repository only persists a decision already made
 * elsewhere: it does not decide whether a reviewer is authorized (`VerificationPolicy`, domain
 * layer) nor which `Prescription.status` transition follows (`IPrescriptionRepository.
 * updateStatus`, called separately by the command in the same transaction, §12 "Approve/Reject
 * prescription"). No update/delete method exists by design (ADR-006 append-only discipline).
 */
@Injectable()
export class PrismaVerificationRepository implements IVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async create(
    data: NewVerificationReviewData,
    tx?: unknown,
  ): Promise<VerificationReviewSnapshot> {
    const row = await this.client(tx).verificationReview.create({
      data: {
        prescriptionId: data.prescriptionId,
        reviewerUserId: data.reviewerUserId,
        pharmacyId: data.pharmacyId ?? null,
        decision: data.decision,
        reason: data.reason ?? null,
        legibilityOk: data.legibilityOk ?? null,
        validityOk: data.validityOk ?? null,
      },
    });
    return toDomain(row);
  }

  async listByPrescriptionId(
    prescriptionId: string,
    tx?: unknown,
  ): Promise<VerificationReviewSnapshot[]> {
    const rows = await this.client(tx).verificationReview.findMany({
      where: { prescriptionId },
      orderBy: { reviewedAt: 'asc' },
    });
    return rows.map(toDomain);
  }
}
