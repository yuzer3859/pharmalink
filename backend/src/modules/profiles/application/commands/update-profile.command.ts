import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { Gender } from '../../domain/enums';
import { ProfileErrors } from '../../domain/errors';
import { profileUpdatedEvent } from '../../domain/events';
import {
  IProfileRepository,
  PROFILE_REPOSITORY,
} from '../../domain/repositories/profile.repository';
import { PhoneNumber } from '../../domain/value-objects/phone-number';
import { UNIT_OF_WORK, IUnitOfWork } from '../ports/unit-of-work.port';
import { ProfileView, toProfileView } from '../queries/get-profile.query';
import { runWithDefaultAddressRetry } from '../support/default-address-conflict';

export interface UpdateProfileInput {
  userId: string;
  fullName?: string;
  gender?: string;
  dateOfBirth?: string;
  secondaryPhone?: string;
  timezone?: string;
}

/**
 * PATCH /profile/me (module-02 §8.1). All fields are optional PATCH semantics, but at least one
 * must be present — checked here, not the DTO, since "empty body" is a cross-field rule.
 */
@Injectable()
export class UpdateProfileCommand {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: IProfileRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateProfileInput): Promise<ProfileView> {
    if (
      input.fullName === undefined &&
      input.gender === undefined &&
      input.dateOfBirth === undefined &&
      input.secondaryPhone === undefined &&
      input.timezone === undefined
    ) {
      throw ProfileErrors.validation('At least one field is required.');
    }

    const secondaryPhone =
      input.secondaryPhone !== undefined
        ? PhoneNumber.create(input.secondaryPhone, 'secondaryPhone').value
        : undefined;

    // DEFECT-PROFILES-002 / ADR-010: previously this command held NO transaction at all — the
    // profile update, the audit entry, and the outbox event were three independent statements,
    // so a failure after the profile row was saved (e.g. the outbox insert) left a committed
    // state change with no audit trail and no event. All three now commit atomically in one
    // transaction (Serializable, to keep the audit hash chain fork-safe); a concurrent write
    // conflict is retried against freshly re-read state rather than surfacing a 500.
    const profile = await runWithDefaultAddressRetry(this.uow, async (tx) => {
      const found = await this.profiles.findOrCreateByUserId(input.userId, tx);

      const changedFields = found.applyEdits({
        fullName: input.fullName,
        gender: input.gender !== undefined ? (input.gender as Gender) : undefined,
        dateOfBirth: input.dateOfBirth !== undefined ? new Date(input.dateOfBirth) : undefined,
        secondaryPhone,
        timezone: input.timezone,
      });

      await this.profiles.save(found, tx);

      await this.audit.record(
        {
          actorUserId: input.userId,
          action: 'PROFILE_UPDATED',
          resourceType: 'CustomerProfile',
          resourceId: found.id,
          context: { fields: changedFields },
        },
        tx,
      );

      await this.outbox.write(
        profileUpdatedEvent({ userId: found.userId, profileId: found.id, fields: changedFields }),
        tx as never,
      );

      return found;
    });

    return toProfileView(profile);
  }
}
