import { Injectable } from '@nestjs/common';
import { Prisma, VerificationRequest as PrismaVerificationRequest } from '@prisma/client';
import { ApiException } from '../../../../shared/errors/api-exception';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  VerificationDocument,
  VerificationRequest,
} from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { PaginatedResult } from '../../domain/repositories/auth.repositories';
import {
  IConsentRepository,
  IVerificationRepository,
  NewVerificationRequest,
  SaveExpectation,
  VerificationSearchFilter,
} from '../../domain/repositories/verification.repository';

function toDocuments(raw: Prisma.JsonValue | null): VerificationDocument[] {
  return Array.isArray(raw) ? (raw as unknown as VerificationDocument[]) : [];
}

function toDomain(row: PrismaVerificationRequest): VerificationRequest {
  return VerificationRequest.rehydrate({
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    type: row.type as unknown as VerificationType,
    status: row.status as unknown as VerificationStatus,
    faydaIdEncrypted: row.faydaIdEncrypted,
    documents: toDocuments(row.documents),
    reviewerId: row.reviewerId,
    rejectReason: row.rejectReason,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    expiresAt: row.expiresAt,
  });
}

@Injectable()
export class PrismaVerificationRepository implements IVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: NewVerificationRequest): Promise<VerificationRequest> {
    const row = await this.prisma.verificationRequest.create({
      data: {
        userId: data.userId,
        organizationId: data.organizationId,
        type: data.type as unknown as PrismaVerificationRequest['type'],
        faydaIdEncrypted: data.faydaIdEncrypted,
        documents: data.documents as unknown as Prisma.InputJsonValue,
      },
    });
    return toDomain(row);
  }

  async findById(id: string): Promise<VerificationRequest | null> {
    const row = await this.prisma.verificationRequest.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findPendingForUser(
    userId: string,
    type: VerificationType,
  ): Promise<VerificationRequest | null> {
    const row = await this.prisma.verificationRequest.findFirst({
      where: {
        userId,
        type: type as unknown as PrismaVerificationRequest['type'],
        status: VerificationStatus.PENDING as unknown as PrismaVerificationRequest['status'],
      },
      orderBy: { submittedAt: 'desc' },
    });
    return row ? toDomain(row) : null;
  }

  async listForUser(userId: string): Promise<VerificationRequest[]> {
    const rows = await this.prisma.verificationRequest.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
    });
    return rows.map(toDomain);
  }

  async listByStatus(
    status: VerificationStatus,
    page: number,
    size: number,
  ): Promise<PaginatedResult<VerificationRequest>> {
    const where = { status: status as unknown as PrismaVerificationRequest['status'] };
    const [rows, total] = await Promise.all([
      this.prisma.verificationRequest.findMany({
        where,
        orderBy: { submittedAt: 'asc' },
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.verificationRequest.count({ where }),
    ]);
    return { items: rows.map(toDomain), total, page, size };
  }

  async search(
    filter: VerificationSearchFilter,
    page: number,
    size: number,
  ): Promise<PaginatedResult<VerificationRequest>> {
    const where: Prisma.VerificationRequestWhereInput = {
      ...(filter.status && {
        status: filter.status as unknown as PrismaVerificationRequest['status'],
      }),
      ...(filter.type && { type: filter.type as unknown as PrismaVerificationRequest['type'] }),
      ...(filter.userId && { userId: filter.userId }),
      ...(filter.organizationId && { organizationId: filter.organizationId }),
      ...((filter.submittedFrom || filter.submittedTo) && {
        submittedAt: {
          ...(filter.submittedFrom && { gte: filter.submittedFrom }),
          ...(filter.submittedTo && { lt: filter.submittedTo }),
        },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.verificationRequest.findMany({
        where,
        // Oldest first is the queue's natural order; `id` breaks same-millisecond ties so a page
        // boundary never shows one request twice and another never.
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.verificationRequest.count({ where }),
    ]);
    return { items: rows.map(toDomain), total, page, size };
  }

  async listExpired(now: Date, limit: number): Promise<VerificationRequest[]> {
    const rows = await this.prisma.verificationRequest.findMany({
      where: {
        status: VerificationStatus.APPROVED as unknown as PrismaVerificationRequest['status'],
        expiresAt: { not: null, lt: now },
      },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map(toDomain);
  }

  async save(request: VerificationRequest, expect?: SaveExpectation): Promise<void> {
    const props = request.toProps();
    const data = {
      status: props.status as unknown as PrismaVerificationRequest['status'],
      documents: props.documents as unknown as Prisma.InputJsonValue,
      reviewerId: props.reviewerId,
      rejectReason: props.rejectReason,
      reviewedAt: props.reviewedAt,
      expiresAt: props.expiresAt,
    };

    if (!expect) {
      await this.prisma.verificationRequest.update({ where: { id: props.id }, data });
      return;
    }

    // Compare-and-set on the status column: one statement, atomic in Postgres, so of two
    // reviewers who both loaded PENDING exactly one matches and the other affects zero rows.
    const result = await this.prisma.verificationRequest.updateMany({
      where: {
        id: props.id,
        status: expect.status as unknown as PrismaVerificationRequest['status'],
      },
      data,
    });
    if (result.count === 1) {
      return;
    }

    const current = await this.prisma.verificationRequest.findUnique({
      where: { id: props.id },
      select: { status: true },
    });
    if (!current) {
      throw ApiException.notFound('Verification request not found');
    }
    throw IdentityErrors.verificationClosed(current.status);
  }
}

@Injectable()
export class PrismaConsentRepository implements IConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(userId: string, type: string, granted: boolean, version: string): Promise<void> {
    await this.prisma.consent.create({
      data: {
        userId,
        type: type as unknown as Prisma.ConsentCreateInput['type'],
        granted,
        version,
      },
    });
  }
}
