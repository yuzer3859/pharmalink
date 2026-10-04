import { Injectable } from '@nestjs/common';
import { Prisma, JobOffer as PrismaJobOffer } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { JobOfferProps } from '../../domain/entities/job-offer.entity';
import { JobOfferStatus } from '../../domain/enums';
import {
  IJobOfferRepository,
  JobOfferResponseUpdate,
} from '../../domain/repositories/job-offer.repository';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Prisma adapter for `IJobOfferRepository` (§8's `job_offers`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses the port (ADR-002). The
 * mapping here is almost an identity, because an offer is flat: the aggregate's value is in its
 * rules, not in a shape the table cannot hold.
 */
@Injectable()
export class PrismaJobOfferRepository implements IJobOfferRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<JobOfferProps | null> {
    const row = await this.client(tx).jobOffer.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  /**
   * `findFirst` rather than `findUnique` only because Prisma cannot express the partial unique
   * index that guarantees there is at most one. The guarantee is real — see
   * `job_offers_one_live_per_job` in `20260917000000_module08_job_offers_dispatch` — so this
   * cannot silently pick one of several.
   */
  async findPendingForJob(jobId: string, tx?: unknown): Promise<JobOfferProps | null> {
    const row = await this.client(tx).jobOffer.findFirst({
      where: { jobId, status: JobOfferStatus.OFFERED },
    });
    return row ? toProps(row) : null;
  }

  async listForJob(jobId: string, tx?: unknown): Promise<JobOfferProps[]> {
    const rows = await this.client(tx).jobOffer.findMany({
      where: { jobId },
      orderBy: { round: 'desc' },
    });
    return rows.map(toProps);
  }

  async maxRoundForJob(jobId: string, tx?: unknown): Promise<number> {
    const result = await this.client(tx).jobOffer.aggregate({
      where: { jobId },
      _max: { round: true },
    });
    return result._max.round ?? 0;
  }

  async create(offer: JobOfferProps, tx?: unknown): Promise<JobOfferProps> {
    const row = await this.client(tx).jobOffer.create({
      data: {
        id: offer.id,
        jobId: offer.jobId,
        driverId: offer.driverId,
        status: offer.status,
        offeredAt: offer.offeredAt,
        expiresAt: offer.expiresAt,
        respondedAt: offer.respondedAt,
        reason: offer.reason,
        round: offer.round,
      },
    });
    return toProps(row);
  }

  /**
   * Compare-and-set on `status`, so only one answer can land.
   *
   * `updateMany` with `status: OFFERED` in the `where` clause is what makes this atomic without a
   * read-then-write: Postgres either matches the row while it is still pending or matches nothing.
   * `count === 0` is reported as `null` rather than thrown so the caller can say *why* the answer
   * lost — a second accept and a decline-after-expiry need different messages, and only the
   * caller knows which it was attempting.
   */
  async respond(
    id: string,
    update: JobOfferResponseUpdate,
    tx?: unknown,
  ): Promise<JobOfferProps | null> {
    const client = this.client(tx);
    const result = await client.jobOffer.updateMany({
      where: { id, status: JobOfferStatus.OFFERED },
      data: {
        status: update.status,
        respondedAt: update.respondedAt,
        reason: update.reason,
      },
    });
    if (result.count === 0) {
      return null;
    }
    const row = await client.jobOffer.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  async listExpired(now: Date, limit: number, tx?: unknown): Promise<JobOfferProps[]> {
    const rows = await this.client(tx).jobOffer.findMany({
      where: { status: JobOfferStatus.OFFERED, expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map(toProps);
  }

  async listPendingForDriver(
    driverId: string,
    now: Date,
    limit: number,
    tx?: unknown,
  ): Promise<JobOfferProps[]> {
    const rows = await this.client(tx).jobOffer.findMany({
      where: { driverId, status: JobOfferStatus.OFFERED, expiresAt: { gt: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    return rows.map(toProps);
  }

  /**
   * Raw SQL because Prisma has no `FOR UPDATE SKIP LOCKED`. Served by the same
   * `(status, expiresAt)` index `listExpired` uses.
   *
   * The column list is spelled out rather than `SELECT *` so that a future column added to
   * `job_offers` cannot silently arrive in `JobOfferProps` without anyone mapping it.
   */
  async lockNextExpired(
    now: Date,
    excludeIds: readonly string[],
    tx: unknown,
  ): Promise<JobOfferProps | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<PrismaJobOffer[]>`
      SELECT "id", "jobId", "driverId", "status", "offeredAt", "expiresAt",
             "respondedAt", "reason", "round"
      FROM "job_offers"
      WHERE "status" = 'OFFERED'::"JobOfferStatus"
        AND "expiresAt" < ${now}
        AND NOT ("id" = ANY(${[...excludeIds]}::text[]))
      ORDER BY "expiresAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    return rows[0] ? toProps(rows[0]) : null;
  }
}

function toProps(row: PrismaJobOffer): JobOfferProps {
  return {
    id: row.id,
    jobId: row.jobId,
    driverId: row.driverId,
    status: row.status,
    offeredAt: row.offeredAt,
    expiresAt: row.expiresAt,
    respondedAt: row.respondedAt,
    reason: row.reason,
    round: row.round,
  };
}
