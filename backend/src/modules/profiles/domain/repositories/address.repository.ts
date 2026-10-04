import { Address } from '../entities/address.entity';

export const ADDRESS_REPOSITORY = Symbol('ADDRESS_REPOSITORY');

/**
 * Persistence port for the Address entity (module-02 §10). The domain depends on this
 * interface; the Prisma adapter implements it in the infrastructure layer.
 */
export interface IAddressRepository {
  findById(id: string, tx?: unknown): Promise<Address | null>;
  /** Non-deleted addresses for a user, ordered `isDefault desc, updatedAt desc` (§8.2). */
  listByUserId(userId: string): Promise<Address[]>;
  /** Count of non-deleted addresses, for the max-20 invariant (§3.2). */
  countByUserId(userId: string, tx?: unknown): Promise<number>;
  create(address: Address, tx?: unknown): Promise<void>;
  save(address: Address, tx?: unknown): Promise<void>;
  /**
   * Clears `isDefault` on whichever non-deleted address currently holds it for this user, if
   * any, and returns that address's id (or null if none was default). Used inside the atomic
   * default-swap transaction (§6.3/§8.2) so the partial unique index is never transiently
   * violated.
   */
  clearDefaultForUser(userId: string, tx?: unknown): Promise<string | null>;
  /** The most-recently-updated remaining non-deleted address, for default promotion on delete (§8.2). */
  findMostRecentlyUpdatedForUser(userId: string, excludeId: string, tx?: unknown): Promise<Address | null>;
}
