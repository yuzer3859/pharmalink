import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  DriverProfile,
  DriverProfileProps,
} from '../../domain/entities/driver-profile.entity';
import { DriverAvailability } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import { isDriverSettableAvailability } from '../../domain/services/driver-availability-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface SetDriverAvailabilityInput {
  /** Module 01 `users.id`. Callers know the authenticated user, not the profile id. */
  userId: string;
  /** `ONLINE` or `OFFLINE`. `BUSY` is dispatch's and is refused here. */
  availability: DriverAvailability;
  actorUserId?: string | null;
}

export interface SetDriverAvailabilityResult {
  profile: DriverProfileProps;
  /** `false` when the driver was already in the requested state and nothing was written. */
  changed: boolean;
}

/**
 * `SetDriverAvailability` (§3.1 F-DRV-02, §9.1's `PUT /driver/availability`) — the driver's
 * online/offline toggle, and **the one place BRULE-09 is enforced**.
 *
 * ## The verification gate, and why it is asymmetric
 *
 * Going `ONLINE` is the moment a driver becomes dispatchable — the moment the platform may hand
 * them medicines to carry — so it is the moment the design's "only verified, onboarded drivers"
 * invariant (§5.3, BRULE-09) has to hold. `IIdentityPort` answers that live, from Module 01's own
 * tables, and it **fails closed**: no record, not a driver, not active, documents unapproved or
 * expired all refuse.
 *
 * Going `OFFLINE` is not gated, deliberately. Refusing to let an unverified driver *stop* working
 * would be absurd on its face, and concretely harmful: a driver whose documents lapse mid-shift
 * would be locked into the online state they are no longer allowed to be in, which is the exact
 * opposite of what the rule is for.
 *
 * The check is not cached and no copy of its answer is stored — see `IIdentityPort` for why the
 * Phase-0 `is_verified` mirror was removed rather than populated.
 *
 * ## Why an audit entry and not an event
 *
 * Availability changes are audited (§13) because they are the record of who was working when —
 * the first thing anyone asks after a late or lost delivery. They emit **no domain event**: the
 * catalogue has no `DriverAvailabilityChanged` row, its only plausible consumer is a dispatcher
 * that does not exist, and inventing a contract that nothing reads would fix its shape before the
 * component that needs it could have an opinion.
 */
@Injectable()
export class SetDriverAvailabilityCommand {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: SetDriverAvailabilityInput): Promise<SetDriverAvailabilityResult> {
    const userId = requireText(input.userId, 'userId');

    const stored = await this.profiles.findByUserId(userId);
    if (!stored) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const profile = DriverProfile.rehydrate(stored);

    // Refuse an unsettable value (`BUSY`) before anything else, so the answer does not depend on
    // what the driver's current state happens to be. The aggregate is still the authority — this
    // call throws from `setAvailability` — it is just asked first.
    if (!isDriverSettableAvailability(input.availability)) {
      profile.setAvailability(input.availability);
    }

    // Idempotent: a retried request, or a driver tapping a toggle twice. Returned *before* the
    // Module 01 read, deliberately — a request that changes nothing should not put a two-table
    // cross-module query on a retry path, and the answer could not change what is written
    // (nothing). Writing an audit entry here would also put noise in the one trail an
    // investigation reads.
    if (stored.availability === input.availability) {
      return { profile: stored, changed: false };
    }

    // BRULE-09, checked before the transaction: it is a cross-module read, and ADR-014's
    // discipline keeps those outside a `Serializable` transaction. Nothing it decides can be
    // invalidated by the write that follows — a driver's Module 01 verification does not depend
    // on their Module 08 availability.
    //
    // Checked *before* the domain transition so that an unverified driver with no open shift is
    // told the more fundamental thing: that they are not verified, rather than that they should
    // start a shift they would then be refused.
    if (input.availability === DriverAvailability.ONLINE) {
      const identity = await this.identity.getDriverIdentity(userId);
      if (!identity.isEligible) {
        throw DeliveryErrors.driverNotVerified(userId, identity.reason ?? 'UNKNOWN');
      }
    }

    const next = profile.setAvailability(input.availability);

    const props = next.toProps();
    const saved = await runWithDeliveryRetry(this.uow, async (tx) => {
      const written = await this.profiles.save(props, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId ?? userId,
          action: 'DELIVERY_DRIVER_AVAILABILITY_CHANGED',
          resourceType: 'DriverProfile',
          resourceId: written.id,
          context: {
            driverUserId: written.userId,
            from: stored.availability,
            to: written.availability,
            onShift: written.shiftStartedAt !== null,
          },
        },
        tx,
      );
      return written;
    });

    return { profile: saved, changed: true };
  }
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
