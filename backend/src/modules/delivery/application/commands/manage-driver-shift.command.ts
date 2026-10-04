import { Inject, Injectable } from '@nestjs/common';
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
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

export interface DriverShiftInput {
  /** Module 01 `users.id`. */
  userId: string;
  actorUserId?: string | null;
}

export interface DriverShiftResult {
  profile: DriverProfileProps;
  /** `false` when the shift was already in the requested state and nothing was written. */
  changed: boolean;
}

/**
 * `ManageDriverShift` (§3.1 F-DRV-02's "shift status") — opening and closing a driver's working
 * window.
 *
 * ## Why both halves live in one command
 *
 * A shift is one lifecycle with one invariant, and the two halves are not independent: ending a
 * shift has to force `OFFLINE`, because a driver left `ONLINE` with no open shift is the exact
 * contradiction `DriverAvailabilityPolicy.isConsistent` exists to forbid. Splitting them across
 * two files would put one rule in two places, and the rule is the whole content of both.
 *
 * The transition logic itself is the aggregate's; this command supplies persistence, the audit
 * trail and the transaction. Both operations are idempotent for the reason `DriverProfile`
 * documents — the driver app posts them on launch and after every reconnection (NFR-LOC-04), and
 * a repeat means "still on shift", not "start another".
 *
 * ## Shift is not verification-gated, and ending one does not touch jobs
 *
 * Starting a shift does not make a driver dispatchable — going `ONLINE` does, and that is where
 * BRULE-09 is checked. Gating the shift as well would refuse an unverified driver the ability to
 * open the app, and would say nothing that the online gate does not already say.
 *
 * Ending a shift leaves the driver's open jobs alone. §11.5 gives reassignment its own flow, which
 * has to find a replacement driver *before* taking the work away; releasing jobs here would
 * strand medicines that are already in a bag with nobody assigned to them.
 */
@Injectable()
export class ManageDriverShiftCommand {
  constructor(
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async start(input: DriverShiftInput): Promise<DriverShiftResult> {
    return this.apply(input, 'start');
  }

  async end(input: DriverShiftInput): Promise<DriverShiftResult> {
    return this.apply(input, 'end');
  }

  private async apply(
    input: DriverShiftInput,
    operation: 'start' | 'end',
  ): Promise<DriverShiftResult> {
    const userId = requireText(input.userId, 'userId');

    const stored = await this.profiles.findByUserId(userId);
    if (!stored) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    const profile = DriverProfile.rehydrate(stored);
    const next = operation === 'start' ? profile.startShift() : profile.endShift();
    if (next === profile) {
      return { profile: stored, changed: false };
    }

    const props = next.toProps();
    const saved = await runWithDeliveryRetry(this.uow, async (tx) => {
      const written = await this.profiles.save(props, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId ?? userId,
          action:
            operation === 'start'
              ? 'DELIVERY_DRIVER_SHIFT_STARTED'
              : 'DELIVERY_DRIVER_SHIFT_ENDED',
          resourceType: 'DriverProfile',
          resourceId: written.id,
          context: {
            driverUserId: written.userId,
            // The shift's own boundaries, because "who was working when" is the question this
            // trail is read to answer. On an end, `shiftStartedAt` is already null on the new
            // state, so the *previous* start is what gets recorded — otherwise the entry would
            // say a shift ended without saying which one.
            shiftStartedAt: (operation === 'start'
              ? written.shiftStartedAt
              : stored.shiftStartedAt
            )?.toISOString() ?? null,
            availability: written.availability,
            // An end forces OFFLINE; recording both makes that visible in the trail rather than
            // implicit in the two entries a reader would otherwise have to correlate.
            availabilityWas: stored.availability,
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
