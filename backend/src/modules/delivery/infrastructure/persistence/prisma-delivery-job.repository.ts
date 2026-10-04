import { Injectable } from '@nestjs/common';
import { Prisma, DeliveryJob as PrismaDeliveryJob } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryItemSummary,
  DeliveryJobProps,
} from '../../domain/entities/delivery-job.entity';
import { DeliveryJobStatus } from '../../domain/enums';
import {
  DeliveryJobPage,
  DeliveryJobStateExpectation,
  DeliveryJobStateUpdate,
  DeliveryStatusHistoryEntry,
  DeliveryStatusHistoryRecord,
  IDeliveryJobRepository,
  ListDeliveryJobsCriteria,
} from '../../domain/repositories/delivery-job.repository';
import { ACTIVE_JOB_STATUSES } from '../../domain/services/driver-availability-policy';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Prisma adapter for `IDeliveryJobRepository` (§8's `delivery_jobs`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses the port (ADR-002). The
 * mapping is confined to this file, which is also where the schema's shape and the domain's differ:
 * the table stores `pickupLat`/`pickupLng` as independent nullable columns while the domain holds a
 * `GeoPoint` or nothing, and `items` is a `Json` column while the domain holds a typed list.
 *
 * **`DeliveryJob.rehydrate` is deliberately not called here.** A repository returns props; the
 * aggregate is reconstructed by whoever needs behaviour, exactly as Module 07's repositories
 * return `SettlementProps`/`PaymentProps`. Re-running invariants on every list row would turn one
 * corrupt row into a failed page.
 */
@Injectable()
export class PrismaDeliveryJobRepository implements IDeliveryJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findByFulfillmentId(
    fulfillmentId: string,
    tx?: unknown,
  ): Promise<DeliveryJobProps | null> {
    // `findUnique` on the natural key, which the unique index makes possible — and which is what
    // makes this a consistent read of the same constraint that resolves the creation race, rather
    // than a "first match" that could disagree with it.
    const row = await this.client(tx).deliveryJob.findUnique({ where: { fulfillmentId } });
    return row ? toProps(row) : null;
  }

  async findById(id: string, tx?: unknown): Promise<DeliveryJobProps | null> {
    const row = await this.client(tx).deliveryJob.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  /** On the Phase-0 `delivery_jobs_orderId_idx`. Ordered so a split order's jobs read stably. */
  async findByOrderId(orderId: string, tx?: unknown): Promise<DeliveryJobProps[]> {
    const rows = await this.client(tx).deliveryJob.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
    });
    return rows.map(toProps);
  }

  async listStatusHistory(
    jobId: string,
    tx?: unknown,
  ): Promise<DeliveryStatusHistoryRecord[]> {
    const rows = await this.client(tx).deliveryStatusHistory.findMany({
      where: { jobId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      fromStatus: row.fromStatus as DeliveryJobStatus | null,
      toStatus: row.toStatus as DeliveryJobStatus,
      actorType: row.actorType,
      actorId: row.actorId,
      reason: row.reason,
      lat: row.lat,
      lng: row.lng,
      createdAt: row.createdAt,
    }));
  }

  async list(criteria: ListDeliveryJobsCriteria, tx?: unknown): Promise<DeliveryJobPage> {
    // `undefined` is the only thing that leaves `pharmacyId` unconstrained; an empty array is
    // passed through as `in: []` and matches nothing. See the criteria's doc comment.
    const where: Prisma.DeliveryJobWhereInput = {
      ...(criteria.pharmacyIds === undefined
        ? {}
        : { pharmacyId: { in: criteria.pharmacyIds } }),
      ...(criteria.assignedDriverId ? { assignedDriverId: criteria.assignedDriverId } : {}),
      // Both may be present. `status` narrows `statuses` rather than replacing it, so a caller
      // holding a fixed allow-list can offer a filter inside it without widening past it.
      ...(criteria.statuses === undefined ? {} : { status: { in: criteria.statuses } }),
      ...(criteria.status
        ? {
            status:
              criteria.statuses === undefined
                ? criteria.status
                : { in: criteria.statuses.filter((s) => s === criteria.status) },
          }
        : {}),
    };
    const client = this.client(tx);
    const [rows, total] = await Promise.all([
      client.deliveryJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      client.deliveryJob.count({ where }),
    ]);
    return { items: rows.map(toProps), total };
  }

  /**
   * BRULE-28's count, taken from the jobs themselves rather than a stored counter.
   *
   * Uses the composite `(assignedDriverId, status)` index added with the driver-operational-profile
   * work; without it this would scan every delivery ever made, on the path of every future accept.
   */
  async countActiveJobs(driverProfileId: string, tx?: unknown): Promise<number> {
    return this.client(tx).deliveryJob.count({
      where: {
        assignedDriverId: driverProfileId,
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
    });
  }

  /**
   * One grouped count for the whole candidate pool, on the same
   * `(assignedDriverId, status)` index `countActiveJobs` uses.
   *
   * Short-circuits on an empty list: `groupBy` with `in: []` is a round trip that can only return
   * nothing, and dispatch calls this on a path where no online drivers is an ordinary outcome.
   */
  async countActiveJobsByDriver(
    driverProfileIds: readonly string[],
    tx?: unknown,
  ): Promise<Map<string, number>> {
    if (driverProfileIds.length === 0) {
      return new Map();
    }
    const rows = await this.client(tx).deliveryJob.groupBy({
      by: ['assignedDriverId'],
      where: {
        assignedDriverId: { in: [...driverProfileIds] },
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.assignedDriverId !== null) {
        counts.set(row.assignedDriverId, row._count._all);
      }
    }
    return counts;
  }

  /** Append-only (§8, §13). There is no update or delete for this table anywhere in the module. */
  async appendStatusHistory(entry: DeliveryStatusHistoryEntry, tx?: unknown): Promise<void> {
    await this.client(tx).deliveryStatusHistory.create({
      data: {
        jobId: entry.jobId,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        reason: entry.reason ?? null,
        lat: entry.lat ?? null,
        lng: entry.lng ?? null,
      },
    });
  }

  async create(job: DeliveryJobProps, tx?: unknown): Promise<DeliveryJobProps> {
    const row = await this.client(tx).deliveryJob.create({
      data: {
        id: job.id,
        orderId: job.orderId,
        fulfillmentId: job.fulfillmentId,
        pharmacyId: job.pharmacyId,
        branchId: job.branchId,
        pickupLat: job.pickupPoint?.lat ?? null,
        pickupLng: job.pickupPoint?.lng ?? null,
        pickupAddress: job.pickupAddress,
        dropoffLat: job.dropoffPoint?.lat ?? null,
        dropoffLng: job.dropoffPoint?.lng ?? null,
        dropoffAddress: job.dropoffAddress,
        // The item manifest lives in the job's own `dropoffAddress`-adjacent JSON rather than in a
        // child table: it is a frozen snapshot that is only ever read whole, never queried or
        // joined, and a table would invite exactly the joins this boundary forbids.
        items: job.items as unknown as Prisma.InputJsonValue,
        assignedDriverId: job.assignedDriverId,
        status: job.status,
        isColdChain: job.isColdChain,
        isCod: job.isCod,
        codAmount: job.codAmount,
        // Both Phase-0 columns, written for the first time by the delivery-fee work. `deliveryFee`
        // is the amount Module 06 charged, never one this module computed; `distanceMeters` is the
        // route the job was dispatched against. Neither is ever updated after this insert — there
        // is no `update` path in this repository that touches either column.
        deliveryFee: job.deliveryFee,
        distanceMeters: job.distanceMeters,
        pickedUpAt: job.pickedUpAt,
        deliveredAt: job.deliveredAt,
        createdAt: job.createdAt,
      },
    });
    return toProps(row);
  }

  /**
   * Compare-and-set on `status`, so a stale post cannot overwrite a committed one.
   *
   * `updateMany` with the expected status in the `where` clause is what makes this atomic without
   * a read-then-write: Postgres either matches the row in its current state or matches nothing,
   * and `count === 0` is reported as `null` rather than thrown so the caller can decide whether it
   * is an idempotent retry or a genuine conflict.
   *
   * The `where` clause carries whichever of `status` and `assignedDriverId` the caller expects, so
   * a stale request loses on either — a job that moved on, or a driver who was released.
   *
   * This is **the guarantee that only one driver can be assigned a job**. Two accepts racing the
   * same `OFFERED` job both try to move it to `ASSIGNED`; the first matches, the second matches
   * nothing and is told the job was already taken.
   */
  async updateState(
    id: string,
    expected: DeliveryJobStateExpectation,
    update: DeliveryJobStateUpdate,
    tx?: unknown,
  ): Promise<DeliveryJobProps | null> {
    const client = this.client(tx);
    const result = await client.deliveryJob.updateMany({
      where: {
        id,
        status: expected.status,
        // Only when the caller asked. `undefined` leaves the driver uncompared; an explicit
        // `null` compares against "unassigned", which is a real expectation a dispatcher holds.
        ...(expected.assignedDriverId !== undefined
          ? { assignedDriverId: expected.assignedDriverId }
          : {}),
      },
      data: {
        status: update.status,
        ...(update.assignedDriverId !== undefined
          ? { assignedDriverId: update.assignedDriverId }
          : {}),
        ...(update.pickedUpAt !== undefined ? { pickedUpAt: update.pickedUpAt } : {}),
        ...(update.deliveredAt !== undefined ? { deliveredAt: update.deliveredAt } : {}),
      },
    });
    if (result.count === 0) {
      return null;
    }
    const row = await client.deliveryJob.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  /**
   * Raw SQL for `FOR UPDATE SKIP LOCKED`, which Prisma cannot express.
   *
   * The `NOT EXISTS` is the important half: a job in `OFFERED` with a live offer is a driver
   * currently deciding, and re-dispatching it would retire a question somebody is in the middle of
   * answering. Only jobs with no pending offer at all are recoverable.
   */
  async lockNextStranded(
    statuses: readonly DeliveryJobStatus[],
    quietSince: Date,
    excludeIds: readonly string[],
    tx: unknown,
  ): Promise<DeliveryJobProps | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<PrismaDeliveryJob[]>`
      SELECT j.* FROM "delivery_jobs" j
      WHERE j."status" = ANY(${[...statuses]}::"DeliveryJobStatus"[])
        AND j."updatedAt" < ${quietSince}
        AND NOT (j."id" = ANY(${[...excludeIds]}::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM "job_offers" o
          WHERE o."jobId" = j."id" AND o."status" = 'OFFERED'::"JobOfferStatus"
        )
      ORDER BY j."updatedAt" ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    `;
    return rows[0] ? toProps(rows[0]) : null;
  }

  /**
   * Raw SQL, joined to `driver_profiles` so the availability test is evaluated by the database at
   * the instant the row is locked rather than read separately and possibly stale by the time the
   * reassignment commits.
   *
   * "Not working" is `availability NOT IN ('ONLINE','BUSY') OR shiftStartedAt IS NULL` — the
   * negation of `DriverAvailabilityPolicy.isWorkingAvailability` combined with its shift
   * invariant. The literals are spelled here because SQL cannot call the policy; the policy's unit
   * tests and this query's e2e coverage are what keep them honest.
   */
  async lockNextStaleAssignment(
    statuses: readonly DeliveryJobStatus[],
    staleSince: Date,
    excludeIds: readonly string[],
    tx: unknown,
  ): Promise<DeliveryJobProps | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<PrismaDeliveryJob[]>`
      SELECT j.* FROM "delivery_jobs" j
      JOIN "driver_profiles" d ON d."id" = j."assignedDriverId"
      WHERE j."status" = ANY(${[...statuses]}::"DeliveryJobStatus"[])
        AND j."updatedAt" < ${staleSince}
        AND NOT (j."id" = ANY(${[...excludeIds]}::text[]))
        AND (
          d."availability" NOT IN ('ONLINE'::"DriverAvailability", 'BUSY'::"DriverAvailability")
          OR d."shiftStartedAt" IS NULL
        )
      ORDER BY j."updatedAt" ASC
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    `;
    return rows[0] ? toProps(rows[0]) : null;
  }
}

function toProps(row: PrismaDeliveryJob): DeliveryJobProps {
  return {
    id: row.id,
    orderId: row.orderId,
    fulfillmentId: row.fulfillmentId,
    pharmacyId: row.pharmacyId,
    branchId: row.branchId,
    pickupPoint: GeoPoint.optional(row.pickupLat, row.pickupLng),
    pickupAddress: row.pickupAddress,
    dropoffPoint: GeoPoint.optional(row.dropoffLat, row.dropoffLng),
    dropoffAddress: row.dropoffAddress,
    items: toItems(row.items),
    isColdChain: row.isColdChain,
    isCod: row.isCod,
    codAmount: row.codAmount,
    deliveryFee: row.deliveryFee,
    distanceMeters: row.distanceMeters,
    status: row.status,
    assignedDriverId: row.assignedDriverId,
    pickedUpAt: row.pickedUpAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The schema's `pickupAddress`/`dropoffAddress` are `Json?` from Phase 0 while the domain holds a
 * plain line, and `items` is `Json?` while the domain holds a typed list. Both are read
 * defensively: a JSON column has no compile-time shape, and a row written before this work — or
 * by a future migration — must degrade to an empty manifest rather than throw inside a read.
 */
function toItems(value: Prisma.JsonValue | null): DeliveryItemSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: DeliveryItemSummary[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const catalogProductId = record.catalogProductId;
    const name = record.name;
    const quantity = record.quantity;
    if (
      typeof catalogProductId === 'string' &&
      typeof name === 'string' &&
      typeof quantity === 'number'
    ) {
      items.push({ catalogProductId, name, quantity });
    }
  }
  return items;
}
