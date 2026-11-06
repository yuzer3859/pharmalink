import { Injectable } from '@nestjs/common';
import { Prisma, ReportType } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IReportJobRepository, ReportJobRow } from '../../application/ports/report-job.repository.port';

/** `report_jobs` over Prisma (Work 90). */
@Injectable()
export class PrismaReportJobRepository implements IReportJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: { type: ReportType; params: Record<string, unknown>; requestedByUserId: string; idempotencyKey: string }): Promise<ReportJobRow | null> {
    try {
      return await this.prisma.reportJob.create({ data: { ...data, params: data.params as Prisma.InputJsonValue } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  findByKey(requestedByUserId: string, idempotencyKey: string): Promise<ReportJobRow | null> {
    return this.prisma.reportJob.findUnique({ where: { requestedByUserId_idempotencyKey: { requestedByUserId, idempotencyKey } } });
  }

  findById(id: string): Promise<ReportJobRow | null> {
    return this.prisma.reportJob.findUnique({ where: { id } });
  }

  async listFor(requestedByUserId: string, page: number, size: number) {
    const [items, total] = await Promise.all([
      this.prisma.reportJob.findMany({ where: { requestedByUserId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * size, take: size }),
      this.prisma.reportJob.count({ where: { requestedByUserId } }),
    ]);
    return { items, total };
  }

  async claimNext(now: Date): Promise<ReportJobRow | null> {
    // Compare-and-set on the status, so two workers can never claim the same job.
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = await this.prisma.reportJob.findFirst({ where: { status: 'QUEUED' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (!next) return null;
      const claimed = await this.prisma.reportJob.updateMany({
        where: { id: next.id, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt: now, attempts: { increment: 1 } },
      });
      if (claimed.count === 1) return this.prisma.reportJob.findUnique({ where: { id: next.id } });
    }
    return null;
  }

  async requeueStale(before: Date): Promise<number> {
    const r = await this.prisma.reportJob.updateMany({ where: { status: 'RUNNING', startedAt: { lt: before } }, data: { status: 'QUEUED' } });
    return r.count;
  }

  async requeue(id: string): Promise<void> {
    await this.prisma.reportJob.updateMany({ where: { id, status: 'RUNNING' }, data: { status: 'QUEUED' } });
  }

  async succeed(id: string, data: { rowCount: number; bytes: number; truncated: boolean; storageRef: string; finishedAt: Date; expiresAt: Date }): Promise<void> {
    await this.prisma.reportJob.update({ where: { id }, data: { status: 'SUCCEEDED', ...data, error: null } });
  }

  async fail(id: string, error: string, finishedAt: Date): Promise<void> {
    await this.prisma.reportJob.update({ where: { id }, data: { status: 'FAILED', error: error.slice(0, 500), finishedAt } });
  }
}
