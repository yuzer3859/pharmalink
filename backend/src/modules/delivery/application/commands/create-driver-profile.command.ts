import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
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
import { ServiceArea } from '../../domain/value-objects/service-area.vo';
import { Vehicle } from '../../domain/value-objects/vehicle.vo';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { isUniqueConstraintViolation, runWithDeliveryRetry } from '../support/delivery-retry';

export interface CreateDriverProfileInput {
  /** Module 01 `users.id` of the driver. The profile's natural key. */
  userId: string;
  vehicleType?: string | null;
  plateNumber?: string | null;
  serviceArea?: { lat: number; lng: number; radiusMeters: number } | null;
  /** BRULE-28 per-driver override. Omitted or `null` means "use the platform limit". */
  maxConcurrent?: number | null;
  /** Who triggered this — the driver themselves, or an admin onboarding them. */
  actorUserId?: string | null;
}

export interface CreateDriverProfileResult {
  profile: DriverProfileProps;
  /** `true` when an existing profile was returned rather than a new one created. */
  replay: boolean;
}

/**
 * `CreateDriverProfile` (§3.1 F-DRV-01) — gives a Module 01 driver their Delivery-side
 * operational record.
 *
 * ## What it checks, and what it deliberately does not
 *
 * It verifies through `IIdentityPort` that the `userId` belongs to a **driver account** — not
 * that the driver is *eligible to work*. A driver whose documents are still under review must be
 * able to set up their vehicle and service area while they wait; refusing the profile would make
 * onboarding depend on the order two independent processes happened to finish in, and would leave
 * an approved driver with nothing configured on their first day.
 *
 * BRULE-09 is enforced where it belongs: at the moment the driver tries to become dispatchable
 * (`SetDriverAvailabilityCommand`). A profile is a place to put settings; going online is a claim
 * to be given medicines to carry.
 *
 * Creating a profile for a user who is not a driver at all *is* refused. That is not a timing
 * question — it is a wrong reference, and accepting it would attach delivery availability to a
 * customer's or a pharmacist's account.
 *
 * ## One profile per driver
 *
 * `userId` is the natural key behind the Phase-0 unique index, and this command converges on it
 * the same way `CreateDeliveryJobCommand` converges on `fulfillmentId`: a cheap pre-check, a
 * re-check inside the transaction, and the unique violation caught and resolved by returning the
 * winner. Two profiles for one driver would mean two availability states for one person, and
 * dispatch reading whichever it found first.
 */
@Injectable()
export class CreateDriverProfileCommand {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CreateDriverProfileInput): Promise<CreateDriverProfileResult> {
    const userId = requireText(input.userId, 'userId');

    const existing = await this.profiles.findByUserId(userId);
    if (existing) {
      return { profile: existing, replay: true };
    }

    const identity = await this.identity.getDriverIdentity(userId);
    // Only the two reasons that say "this is not a driver account". `DOCUMENTS_NOT_APPROVED`,
    // `DOCUMENTS_EXPIRED` and `ACCOUNT_NOT_ACTIVE` are all states a real driver can be in and
    // recover from — see the class comment.
    if (identity.reason === 'USER_NOT_FOUND' || identity.reason === 'NOT_A_DRIVER') {
      throw DeliveryErrors.driverNotVerified(userId, identity.reason);
    }

    const profile = DriverProfile.create({
      id: randomUUID(),
      userId,
      vehicle:
        input.vehicleType === undefined || input.vehicleType === null
          ? null
          : Vehicle.of(input.vehicleType, input.plateNumber),
      serviceArea: toServiceArea(input.serviceArea),
      maxConcurrent: input.maxConcurrent ?? null,
    }).toProps();

    try {
      return await runWithDeliveryRetry(this.uow, async (tx) => {
        const raced = await this.profiles.findByUserId(userId, tx);
        if (raced) {
          return { profile: raced, replay: true };
        }

        const written = await this.profiles.create(profile, tx);

        await this.audit.record(
          {
            actorUserId: input.actorUserId ?? userId,
            action: 'DELIVERY_DRIVER_PROFILE_CREATED',
            resourceType: 'DriverProfile',
            resourceId: written.id,
            context: {
              driverUserId: written.userId,
              vehicleType: written.vehicle?.type ?? null,
              serviceAreaRadiusMeters: written.serviceArea?.radiusMeters ?? null,
              maxConcurrent: written.maxConcurrent,
            },
          },
          tx,
        );

        return { profile: written, replay: false };
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const winner = await this.profiles.findByUserId(userId);
        if (winner) {
          return { profile: winner, replay: true };
        }
      }
      throw err;
    }
  }
}

function toServiceArea(
  input: CreateDriverProfileInput['serviceArea'],
): ServiceArea | null {
  if (input === undefined || input === null) {
    return null;
  }
  return ServiceArea.of(GeoPoint.of(input.lat, input.lng), input.radiusMeters);
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
