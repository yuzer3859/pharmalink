import { CustomerProfile } from '../entities/customer-profile.entity';

export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');

/**
 * Persistence port for the CustomerProfile aggregate (module-02 §10). The domain depends on
 * this interface; the Prisma adapter implements it in the infrastructure layer.
 */
export interface IProfileRepository {
  findByUserId(userId: string): Promise<CustomerProfile | null>;
  /** Idempotent create-if-absent, used by both the event handler and the GET safety net (§2). */
  findOrCreateByUserId(userId: string, tx?: unknown): Promise<CustomerProfile>;
  save(profile: CustomerProfile, tx?: unknown): Promise<void>;
}
