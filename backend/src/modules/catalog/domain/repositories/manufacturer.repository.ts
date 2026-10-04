import { Manufacturer } from '../entities/manufacturer.entity';

export const MANUFACTURER_REPOSITORY = Symbol('MANUFACTURER_REPOSITORY');

/** Persistence port for the Manufacturer entity (module-03 §10). */
export interface IManufacturerRepository {
  findById(id: string, tx?: unknown): Promise<Manufacturer | null>;
  findByName(name: string): Promise<Manufacturer | null>;
  create(manufacturer: Manufacturer, tx?: unknown): Promise<void>;
  save(manufacturer: Manufacturer, tx?: unknown): Promise<void>;
  list(): Promise<Manufacturer[]>;
}
