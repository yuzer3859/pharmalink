import { Inject, Injectable } from '@nestjs/common';
import {
  DriverProfile,
  DriverProfileProps,
} from '../../domain/entities/driver-profile.entity';
import { DeliveryErrors } from '../../domain/errors';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';

export interface UpdateDriverLocationInput {
  /** Module 01 `users.id`. */
  userId: string;
  lat: number;
  lng: number;
  /**
   * When the fix was taken on the handset, not when it arrived. Defaults to now for a client that
   * does not report one — but a buffered client should always report one, because it is the only
   * thing that distinguishes a replayed five-minute-old point from a fresh one.
   */
  recordedAt?: Date;
}

export interface UpdateDriverLocationResult {
  profile: DriverProfileProps;
  /** `false` when the report was older than the stored one and was ignored. */
  applied: boolean;
}

/**
 * `UpdateDriverLocation` (§3.1 F-DRV-03, §9.1's `POST /delivery/location`) — records a driver's
 * last-known position.
 *
 * ## Deliberately the cheapest path in the module
 *
 * No transaction, no audit entry, no event, no serialization retry — three columns, one write.
 * NFR-PERF-04 puts this on a ten-second-per-driver cadence, and every one of those omissions is a
 * cost that would have been paid per fix per driver:
 *
 *  - **No audit entry.** §13 audits operational *decisions*. A position report is telemetry, and
 *    auditing it would bury availability and shift changes — the entries an investigation
 *    actually reads — under thousands of coordinates. §8 already designates `location_snapshots`
 *    as the sampled trail for disputes, which is the right home for location history and is the
 *    tracking work's to fill.
 *  - **No `Serializable` transaction.** ADR-013's rule applies to mutations that co-locate an
 *    audit entry; with no audit entry there is nothing to serialise, and holding the hash chain's
 *    write lock every ten seconds per driver would make it the platform's bottleneck.
 *  - **No event.** Live relay to the customer is §7's WebSocket and Redis fan-out — the tracking
 *    work. Writing to the outbox would push every fix through a durable queue built for
 *    transactional facts.
 *
 * ## Stale reports are ignored, not rejected
 *
 * The driver app buffers while disconnected and flushes on reconnect (NFR-LOC-04), so points
 * arrive out of order as a matter of course. `DriverProfile.recordLocation` returns the profile
 * unchanged for a report no newer than the stored one, and this command reports that as
 * `applied: false` rather than an error — a well-behaved client retrying a request that can never
 * succeed would be worse than the lost fix. A coordinate out of range, or a timestamp far ahead of
 * the server's clock, is a client defect and does throw.
 */
@Injectable()
export class UpdateDriverLocationCommand {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
  ) {}

  async execute(input: UpdateDriverLocationInput): Promise<UpdateDriverLocationResult> {
    const userId = requireText(input.userId, 'userId');

    const stored = await this.profiles.findByUserId(userId);
    if (!stored) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const point = GeoPoint.of(input.lat, input.lng);
    const recordedAt = input.recordedAt ?? new Date();

    const profile = DriverProfile.rehydrate(stored);
    const next = profile.recordLocation(point, recordedAt);
    if (next === profile) {
      return { profile: stored, applied: false };
    }

    const written = await this.profiles.updateLocation(stored.id, {
      lat: point.lat,
      lng: point.lng,
      recordedAt,
    });
    if (!written) {
      // The profile was removed between the read and the write. Nothing to record and nothing to
      // fail over — the caller's next request will get the not-found it deserves.
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    return { profile: written, applied: true };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
