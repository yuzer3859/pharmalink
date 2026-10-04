import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppLogger } from '../logging/app-logger.service';
import { computeEntryHash } from './audit-hash';

export interface RecordAuditParams {
  actorUserId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  context?: Record<string, unknown> | null;
  ip?: string | null;
}

/** Minimal client surface needed to append an entry — satisfied by both PrismaService and a
 * Prisma interactive-transaction client, mirroring OutboxService's OutboxCapableClient. */
type AuditCapableClient = PrismaService | Prisma.TransactionClient;

/**
 * Append-only, hash-chained audit writer (see ADR-012). Each entry binds the previous entry's
 * hash, making the log tamper-evident.
 *
 * DEFECT-PROFILES-002 / ADR-010: callers that must commit the audit entry atomically with a
 * domain state change and an outbox event (i.e. every Profile/Address mutation) pass their
 * active transaction client as `tx`; the read-last-hash + insert then runs as ordinary
 * statements inside that transaction instead of opening a second, independent one — Prisma
 * cannot nest `$transaction` calls, and doing the write outside the caller's transaction would
 * mean a later failure (e.g. the outbox insert) could leave a committed audit entry with no
 * corresponding domain change or event. Preserving the "no fork" guarantee (concurrent appends
 * cannot both read the same `prevHash`) then becomes the CALLER's responsibility — the Profiles
 * module's `PrismaUnitOfWork` runs every mutation transaction at Serializable isolation for
 * exactly this reason, with a bounded retry on the resulting write-conflict (see
 * `application/support/default-address-conflict.ts`).
 *
 * When no `tx` is given (existing standalone callers), the original behavior is unchanged: the
 * read + insert is wrapped in its own dedicated Serializable transaction. NEVER expose an
 * update/delete path for this table.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  async record(
    params: RecordAuditParams,
    tx?: unknown,
  ): Promise<{ id: string; hash: string }> {
    if (tx) {
      return this.append(tx as AuditCapableClient, params);
    }
    return this.prisma.$transaction(
      (standaloneTx) => this.append(standaloneTx, params),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async append(
    client: AuditCapableClient,
    params: RecordAuditParams,
  ): Promise<{ id: string; hash: string }> {
    const last = await client.auditLog.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    });
    const prevHash = last?.hash ?? null;
    const createdAt = new Date();

    const hash = computeEntryHash(prevHash, {
      actorUserId: params.actorUserId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
      context: params.context ?? null,
      ip: params.ip ?? null,
      createdAt: createdAt.toISOString(),
    });

    return client.auditLog.create({
      data: {
        actorUserId: params.actorUserId ?? null,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId ?? null,
        context: (params.context ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: params.ip ?? null,
        prevHash,
        hash,
        createdAt,
      },
      select: { id: true, hash: true },
    });
  }
}
