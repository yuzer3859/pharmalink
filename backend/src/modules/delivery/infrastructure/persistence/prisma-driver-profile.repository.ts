import { Injectable } from '@nestjs/common';
import { Prisma, DriverProfile as PrismaDriverProfile } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { DriverProfileProps } from '../../domain/entities/driver-profile.entity';
import { DriverAvailability } from '../../domain/enums';
import {
  DriverLocationUpdate,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import { ServiceArea } from '../../domain/value-objects/service-area.vo';
import { Vehicle } from '../../domain/value-objects/vehicle.vo';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Prisma adapter for `IDriverProfileRepository` (§8's `driver_profiles`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses the port (ADR-002). The
 * mapping is confined to this file, which is also where the schema's shape and the domain's
 * differ: the table stores a vehicle as two independent text columns, a service area as a `Json`
 * blob and a position as three nullable columns, while the domain holds value objects or nothing.
 *
 * `DriverProfile.rehydrate` is deliberately not called here, the same choice
 * `PrismaDeliveryJobRepository` makes: a repository returns props, and the aggregate is
 * reconstructed by whoever needs behaviour. The invariant check belongs at the point of use, not
 * on every read.
 */
@Injectable()
export class PrismaDriverProfileRepository implements IDriverProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findByUserId(userId: string, tx?: unknown): Promise<DriverProfileProps | null> {
    // `findUnique` on the natural key, which the Phase-0 unique index already provides — and which
    // makes this a consistent read of the same constraint that resolves the creation race, rather
    // than a "first match" that could disagree with it.
    const row = await this.client(tx).driverProfile.findUnique({ where: { userId } });
    return row ? toProps(row) : null;
  }

  async findById(id: string, tx?: unknown): Promise<DriverProfileProps | null> {
    const row = await this.client(tx).driverProfile.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }

  /**
   * The dispatch candidate pool: `ONLINE`, with an open shift.
   *
   * `shiftStartedAt: { not: null }` is redundant against the aggregate's own invariant — a driver
   * cannot be `ONLINE` off shift — and is applied anyway, because this query is what decides who
   * gets handed medicines and a row that drifted must not be the thing that decides it.
   *
   * Ordered by `lastLocationAt` descending so that, when the pool is larger than `limit`, the
   * drivers whose positions are freshest are the ones kept: a stale fix makes the distance term
   * of the ranking a guess, and the point of bounding the scan is to keep the *useful* candidates.
   * `id` breaks ties so the pool itself is deterministic, not just the ranking applied to it.
   */
  async findDispatchCandidates(limit: number, tx?: unknown): Promise<DriverProfileProps[]> {
    const rows = await this.client(tx).driverProfile.findMany({
      where: { availability: DriverAvailability.ONLINE, shiftStartedAt: { not: null } },
      orderBy: [{ lastLocationAt: 'desc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toProps);
  }

  async create(profile: DriverProfileProps, tx?: unknown): Promise<DriverProfileProps> {
    const row = await this.client(tx).driverProfile.create({
      data: {
        id: profile.id,
        userId: profile.userId,
        vehicleType: profile.vehicle?.type ?? null,
        plateNumber: profile.vehicle?.plateNumber ?? null,
        serviceArea: toServiceAreaColumn(profile.serviceArea),
        availability: profile.availability,
        shiftStartedAt: profile.shiftStartedAt,
        lastOnlineAt: profile.lastOnlineAt,
        maxConcurrent: profile.maxConcurrent,
        lastLat: profile.lastLocation?.lat ?? null,
        lastLng: profile.lastLocation?.lng ?? null,
        lastLocationAt: profile.lastLocationAt,
        createdAt: profile.createdAt,
      },
    });
    return toProps(row);
  }

  async save(profile: DriverProfileProps, tx?: unknown): Promise<DriverProfileProps> {
    const row = await this.client(tx).driverProfile.update({
      where: { id: profile.id },
      data: {
        vehicleType: profile.vehicle?.type ?? null,
        plateNumber: profile.vehicle?.plateNumber ?? null,
        serviceArea: toServiceAreaColumn(profile.serviceArea),
        availability: profile.availability,
        shiftStartedAt: profile.shiftStartedAt,
        lastOnlineAt: profile.lastOnlineAt,
        maxConcurrent: profile.maxConcurrent,
      },
    });
    return toProps(row);
  }

  /**
   * Writes only the three location columns.
   *
   * Deliberately does not touch availability, shift or vehicle, even though the caller holds a
   * whole profile: a position report and an availability change can be in flight at the same
   * moment from the same handset, and a full-row write here would carry a stale availability back
   * over a change the driver made a second ago.
   *
   * `updateMany` rather than `update` so that a profile deleted between the read and the write
   * returns `null` instead of throwing `P2025` — a location arriving for a profile that no longer
   * exists is not an error worth failing a request over.
   */
  async updateLocation(
    id: string,
    update: DriverLocationUpdate,
    tx?: unknown,
  ): Promise<DriverProfileProps | null> {
    const client = this.client(tx);
    // Monotonic by compare-and-set: the row moves only to a strictly newer fix. Position reports
    // are the one write in this module that genuinely races with itself — a driver's handset
    // flushes a disconnected buffer while a live fix is in flight, and with several API nodes
    // accepting posts there is no single process whose ordering could settle it. Without the
    // predicate the loser of that race wins the row, and a customer's map jumps backwards to where
    // the driver was five minutes ago. The domain already refuses a stale report it can *see*;
    // this is what covers the ones that interleave after the read.
    await client.driverProfile.updateMany({
      where: {
        id,
        OR: [{ lastLocationAt: null }, { lastLocationAt: { lt: update.recordedAt } }],
      },
      data: { lastLat: update.lat, lastLng: update.lng, lastLocationAt: update.recordedAt },
    });
    // Read back unconditionally rather than off `count`, because `count === 0` is ambiguous here
    // in a way it is not elsewhere: it means either "no such profile" or "a newer fix already
    // won", and only the first is a `null`. Returning what is now stored lets the caller compare
    // timestamps to learn whether its own report was the one that landed, and preserves the
    // established contract that `null` means the profile is gone.
    const row = await client.driverProfile.findUnique({ where: { id } });
    return row ? toProps(row) : null;
  }
}

function toServiceAreaColumn(
  area: ServiceArea | null,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  // Prisma distinguishes "SQL NULL" from "JSON null" on a `Json?` column, and passing a bare
  // `null` is a type error rather than a clearing operation. `JsonNull` is the one that means
  // "this driver has no service area".
  return area === null ? Prisma.JsonNull : (area.toJson() as unknown as Prisma.InputJsonValue);
}

function toProps(row: PrismaDriverProfile): DriverProfileProps {
  return {
    id: row.id,
    userId: row.userId,
    vehicle: Vehicle.fromColumns(row.vehicleType, row.plateNumber),
    serviceArea: ServiceArea.fromJson(row.serviceArea),
    availability: row.availability,
    shiftStartedAt: row.shiftStartedAt,
    lastOnlineAt: row.lastOnlineAt,
    maxConcurrent: row.maxConcurrent,
    lastLocation: GeoPoint.optional(row.lastLat, row.lastLng),
    lastLocationAt: row.lastLocationAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
