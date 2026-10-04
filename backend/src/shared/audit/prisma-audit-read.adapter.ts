import { Injectable } from '@nestjs/common';
import { AuditLog as PrismaAuditLog, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditPage,
  AuditRecordView,
  AuditSearchFilter,
  IAuditReadPort,
} from './audit-read.port';

function toView(row: PrismaAuditLog): AuditRecordView {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    context: row.context,
    ip: row.ip,
    prevHash: row.prevHash,
    hash: row.hash,
    createdAt: row.createdAt,
  };
}

/** `IAuditReadPort` over `audit_logs`. Two `SELECT`s; no other statement exists in this file. */
@Injectable()
export class PrismaAuditReadAdapter implements IAuditReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async search(filter: AuditSearchFilter, page: number, size: number): Promise<AuditPage> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.action && { action: filter.action }),
      ...(filter.actorUserId && { actorUserId: filter.actorUserId }),
      ...(filter.resourceType && { resourceType: filter.resourceType }),
      ...(filter.resourceId && { resourceId: filter.resourceId }),
      ...((filter.from || filter.to) && {
        createdAt: {
          ...(filter.from && { gte: filter.from }),
          ...(filter.to && { lt: filter.to }),
        },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size,
        take: size,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: rows.map(toView), total, page, size };
  }

  async findById(id: string): Promise<AuditRecordView | null> {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    return row ? toView(row) : null;
  }
}
