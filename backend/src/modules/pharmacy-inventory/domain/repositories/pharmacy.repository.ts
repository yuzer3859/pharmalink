import { Pharmacy } from '../entities/pharmacy.entity';

export const PHARMACY_REPOSITORY = Symbol('PHARMACY_REPOSITORY');

export interface IPharmacyRepository {
  findById(id: string, tx?: unknown): Promise<Pharmacy | null>;
  findByOrganizationId(organizationId: string, tx?: unknown): Promise<Pharmacy | null>;
  create(pharmacy: Pharmacy, tx?: unknown): Promise<void>;
  update(pharmacy: Pharmacy, tx?: unknown): Promise<void>;
  /** Pharmacies currently ACTIVE whose license has already expired as of `now` (§4). */
  findExpiredActive(now: Date, limit: number, tx?: unknown): Promise<Pharmacy[]>;
}
