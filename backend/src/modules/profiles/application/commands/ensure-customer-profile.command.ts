import { Inject, Injectable } from '@nestjs/common';
import { CustomerProfile } from '../../domain/entities/customer-profile.entity';
import {
  IProfileRepository,
  PROFILE_REPOSITORY,
} from '../../domain/repositories/profile.repository';

export interface EnsureCustomerProfileInput {
  userId: string;
}

/**
 * Idempotent, lazy creation of the CustomerProfile row (module-02 §2). Invoked by:
 *  - the `identity.user.registered` event handler (the primary path), and
 *  - `GetProfileQuery` as a safety net for out-of-order event delivery — the read path must
 *    never 404 for a valid authenticated user (§8.1, edge case 1).
 */
@Injectable()
export class EnsureCustomerProfileCommand {
  constructor(
    @Inject(PROFILE_REPOSITORY) private readonly profiles: IProfileRepository,
  ) {}

  async execute(input: EnsureCustomerProfileInput): Promise<CustomerProfile> {
    return this.profiles.findOrCreateByUserId(input.userId);
  }
}
