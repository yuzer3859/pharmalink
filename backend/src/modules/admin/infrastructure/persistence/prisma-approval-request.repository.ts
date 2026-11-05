import { Injectable } from '@nestjs/common';
import { ApprovalRequest, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  ApprovalExecutionError,
  ApprovalRequestProps,
  ApprovalStatus,
} from '../../domain/maker-checker/approval-request';
import {
  ApprovalInsertConflict,
  ApprovalPage,
  ApprovalSearchCriteria,
  ApprovalTransition,
  IApprovalRequestRepository,
  NewApprovalRequest,
} from '../../domain/maker-checker/approval-request.repository';

type Client = PrismaService | Prisma.TransactionClient;

/** `approval_requests` (Work 82). Admin's own table; nothing else reads or writes it. */
@Injectable()
export class PrismaApprovalRequestRepository implements IApprovalRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(
    request: NewApprovalRequest,
    tx?: unknown,
  ): Promise<{ created: ApprovalRequestProps } | { conflict: ApprovalInsertConflict }> {
    try {
      const row = await this.client(tx).approvalRequest.create({
        data: {
          id: request.id,
          actionType: request.actionType,
          entityType: request.entityType,
          entityId: request.entityId,
          requiredPermission: request.requiredPermission,
          requestedByUserId: request.requestedByUserId,
          makerIdempotencyKey: request.makerIdempotencyKey,
          summary: request.summary,
          reason: request.reason,
          payload: request.payload as Prisma.InputJsonValue,
          expiresAt: request.expiresAt,
        },
      });
      return { created: toProps(row) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = JSON.stringify(err.meta?.target ?? '');
        return { conflict: target.includes('makerIdempotencyKey') ? 'MAKER_KEY' : 'PENDING_FOR_TARGET' };
      }
      throw err;
    }
  }

  async findById(id: string, tx?: unknown): Promise<ApprovalRequestProps | null> {
    const row = await this.client(tx).approvalRequest.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  async findByMakerKey(
    requestedByUserId: string,
    actionType: string,
    makerIdempotencyKey: string,
  ): Promise<ApprovalRequestProps | null> {
    const row = await this.prisma.approvalRequest.findUnique({
      where: {
        requestedByUserId_actionType_makerIdempotencyKey: {
          requestedByUserId,
          actionType,
          makerIdempotencyKey,
        },
      },
    });
    return row ? toProps(row) : null;
  }

  async findPendingForTarget(actionType: string, entityId: string): Promise<ApprovalRequestProps | null> {
    const row = await this.prisma.approvalRequest.findFirst({
      where: { actionType, entityId, status: ApprovalStatus.PENDING },
    });
    return row ? toProps(row) : null;
  }

  async transition(
    id: string,
    from: ApprovalStatus,
    change: ApprovalTransition,
    tx?: unknown,
    options?: { unexecuted?: boolean },
  ): Promise<ApprovalRequestProps | null> {
    const client = this.client(tx);
    const { count } = await client.approvalRequest.updateMany({
      where: { id, status: from, ...(options?.unexecuted ? { executedAt: null } : {}) },
      data: {
        ...(change.status ? { status: change.status } : {}),
        ...(change.decidedByUserId !== undefined ? { decidedByUserId: change.decidedByUserId } : {}),
        ...(change.decidedAt !== undefined ? { decidedAt: change.decidedAt } : {}),
        ...(change.decisionNote !== undefined ? { decisionNote: change.decisionNote } : {}),
        ...(change.executedAt !== undefined ? { executedAt: change.executedAt } : {}),
        ...(change.executionResult !== undefined
          ? { executionResult: change.executionResult as Prisma.InputJsonValue }
          : {}),
        ...(change.executionError !== undefined
          ? { executionError: change.executionError as unknown as Prisma.InputJsonValue }
          : {}),
        updatedAt: new Date(),
      },
    });
    if (count === 0) {
      return null;
    }
    const row = await client.approvalRequest.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  async search(criteria: ApprovalSearchCriteria, page: number, size: number): Promise<ApprovalPage> {
    const where: Prisma.ApprovalRequestWhereInput = {
      ...(criteria.actionType ? { actionType: criteria.actionType } : {}),
      ...(criteria.requestedByUserId ? { requestedByUserId: criteria.requestedByUserId } : {}),
      ...statusFilter(criteria.status, criteria.now),
    };
    const [rows, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    return { items: rows.map(toProps), total, page, size };
  }

  async findDueForExpiry(now: Date, limit: number): Promise<ApprovalRequestProps[]> {
    const rows = await this.prisma.approvalRequest.findMany({
      where: { status: ApprovalStatus.PENDING, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map(toProps);
  }

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }
}

/** The filter readers mean: PENDING excludes requests already past expiry; EXPIRED includes them. */
function statusFilter(status: ApprovalStatus | undefined, now: Date): Prisma.ApprovalRequestWhereInput {
  if (!status) {
    return {};
  }
  if (status === ApprovalStatus.PENDING) {
    return { status, expiresAt: { gt: now } };
  }
  if (status === ApprovalStatus.EXPIRED) {
    return {
      OR: [{ status }, { status: ApprovalStatus.PENDING, expiresAt: { lte: now } }],
    };
  }
  return { status };
}

function toProps(row: ApprovalRequest): ApprovalRequestProps {
  return {
    id: row.id,
    actionType: row.actionType,
    entityType: row.entityType,
    entityId: row.entityId,
    requiredPermission: row.requiredPermission,
    requestedByUserId: row.requestedByUserId,
    makerIdempotencyKey: row.makerIdempotencyKey,
    summary: row.summary,
    reason: row.reason,
    status: row.status,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    decisionNote: row.decisionNote,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    // Every request this code writes has an expiry; a missing one (impossible here) never expires
    // by accident into "open forever" because it is read as already due.
    expiresAt: row.expiresAt ?? row.createdAt,
    executedAt: row.executedAt,
    executionResult: (row.executionResult as Record<string, unknown> | null) ?? null,
    executionError: (row.executionError as unknown as ApprovalExecutionError | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
