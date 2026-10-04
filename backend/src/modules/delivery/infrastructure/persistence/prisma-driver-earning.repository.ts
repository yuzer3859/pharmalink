import { Injectable } from '@nestjs/common';
import { DriverEarning as PrismaDriverEarning, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DriverEarningProps } from '../../domain/entities/driver-earning.entity';
import { EarningStatus } from '../../domain/enums';
import {
  DriverEarningCriteria,
  DriverEarningPage,
  IDriverEarningRepository,
} from '../../domain/repositories/driver-earning.repository';

/**
 * `IDriverEarningRepository` over Prisma (§8's `driver_earnings`).
 *
 * ## Append-only in the code as well as in the contract
 *
 * There is no `update`, no `updateMany`, no `delete` and no `upsert` anywhere in this file. The
 * interface forbids them and this implementation does not quietly provide one for a future caller
 * to reach for: an earnings row is the platform's record of money owed to a person, and every
 * settlement figure Module 07 eventually produces is a sum of these rows.
 *
 * ## The unique index does the deduplication
 *
 * `insert` catches Prisma's `P2002` on `driver_earnings.jobId` and returns `null` rather than
 * throwing, because a collision is an expected outcome: the outbox is at-least-once (ADR-010) and
 * two API nodes can reach this insert simultaneously.
 *
 * **It does not re-read the winner here**, and that is the important part. A unique violation puts
 * the enclosing Postgres transaction into an aborted state, so a query issued on the same
 * connection immediately afterwards fails — the defect the proof-of-delivery work found against a
 * real database. The caller unwinds the transaction first and reads on a fresh connection.
 */
@Injectable()
export class PrismaDriverEarningRepository implements IDriverEarningRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Prisma.TransactionClient | PrismaService {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async insert(earning: DriverEarningProps, tx?: unknown): Promise<DriverEarningProps | null> {
    try {
      const row = await this.client(tx).driverEarning.create({
        data: {
          id: earning.id,
          driverId: earning.driverId,
          jobId: earning.jobId,
          orderId: earning.orderId,
          fulfillmentId: earning.fulfillmentId,
          base: earning.base,
          distanceComponent: earning.distanceComponent,
          feeShare: earning.feeShare,
          incentive: earning.incentive,
          total: earning.total,
          currency: earning.currency,
          status: earning.status,
          distanceMeters: earning.distanceMeters,
          calculationVersion: earning.calculationVersion,
          createdAt: earning.createdAt,
        },
      });
      return toProps(row);
    } catch (err) {
      if (isJobUniqueViolation(err)) {
        return null;
      }
      throw err;
    }
  }

  async findByJobId(jobId: string, tx?: unknown): Promise<DriverEarningProps | null> {
    const row = await this.client(tx).driverEarning.findUnique({ where: { jobId } });
    return row ? toProps(row) : null;
  }

  /**
   * One driver's ledger, newest first.
   *
   * `driverId` is in the `where` clause of both the page and the count, never applied afterwards,
   * so there is no code path through this method that returns another driver's earnings. The
   * caller resolves that id from the access token; this method has no way to widen it.
   */
  async listByDriver(
    criteria: DriverEarningCriteria,
    tx?: unknown,
  ): Promise<DriverEarningPage> {
    const client = this.client(tx);
    const where = { driverId: criteria.driverId };
    const [rows, total] = await Promise.all([
      client.driverEarning.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: criteria.offset,
        take: criteria.limit,
      }),
      client.driverEarning.count({ where }),
    ]);
    return { items: rows.map(toProps), total };
  }
}

/**
 * Whether this is the `driver_earnings.jobId` unique violation specifically.
 *
 * Narrowed to the one constraint rather than accepting any `P2002`: a collision on some *other*
 * unique index would be a genuine defect, and swallowing it as "already accrued" would hide it
 * behind a successful-looking response.
 */
function isJobUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('jobId'));
}

function toProps(row: PrismaDriverEarning): DriverEarningProps {
  return {
    id: row.id,
    driverId: row.driverId,
    jobId: row.jobId,
    orderId: row.orderId,
    fulfillmentId: row.fulfillmentId,
    base: row.base,
    distanceComponent: row.distanceComponent,
    feeShare: row.feeShare,
    incentive: row.incentive,
    total: row.total,
    currency: row.currency,
    status: row.status as EarningStatus,
    distanceMeters: row.distanceMeters,
    calculationVersion: row.calculationVersion,
    createdAt: row.createdAt,
  };
}
