import { Inject, Injectable } from '@nestjs/common';
import { CustomerProfile } from '../../domain/entities/customer-profile.entity';
import {
  IProfileRepository,
  PROFILE_REPOSITORY,
} from '../../domain/repositories/profile.repository';

export interface ProfileView {
  id: string;
  userId: string;
  fullName: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  secondaryPhone: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toProfileView(profile: CustomerProfile): ProfileView {
  const props = profile.toProps();
  return {
    id: props.id,
    userId: props.userId,
    fullName: props.fullName,
    gender: props.gender,
    dateOfBirth: props.dateOfBirth ? props.dateOfBirth.toISOString().slice(0, 10) : null,
    secondaryPhone: props.secondaryPhone,
    timezone: props.timezone ?? 'Africa/Addis_Ababa',
    createdAt: props.createdAt,
    updatedAt: props.updatedAt,
  };
}

/**
 * GET /profile/me (module-02 §8.1). Lazily upserts (idempotent `findOrCreate`) as a safety net
 * for out-of-order `identity.user.registered` delivery — must never 404 for a valid
 * authenticated user (edge case 1).
 */
@Injectable()
export class GetProfileQuery {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: IProfileRepository,
  ) {}

  async execute(userId: string): Promise<ProfileView> {
    const profile = await this.profiles.findOrCreateByUserId(userId);
    return toProfileView(profile);
  }
}
