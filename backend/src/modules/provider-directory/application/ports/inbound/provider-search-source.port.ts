import type { ProviderType } from '../../../domain/provider-rules';

export const PROVIDER_SEARCH_SOURCE_PORT = Symbol('PROVIDER_SEARCH_SOURCE_PORT');

export interface ProviderSearchLocation {
  locationId: string;
  name: string;
  city: string | null;
  subcity: string | null;
  addressLine: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  emergencyAvailability: 'NONE' | 'BUSINESS_HOURS' | 'H24_7';
  isPrimary: boolean;
}

export interface ProviderSearchService {
  serviceId: string;
  type: string;
  name: string;
  code: string | null;
  price: number | null;
  currency: string;
  durationMinutes: number | null;
  preparationInstructions: string | null;
  locationId: string | null;
}

export interface ProviderSearchSource {
  providerId: string;
  type: ProviderType;
  displayName: string;
  nameAm: string | null;
  description: string | null;
  ratingAvg: number;
  ratingCount: number;
  /** ACTIVE, not deleted, and its licence has not expired (module-09 §6). */
  eligible: boolean;
  /** Active locations only, primary first. */
  locations: ProviderSearchLocation[];
  /** Open departments only. */
  departments: Array<{ name: string; specialty: string | null }>;
  /** Available services only. */
  services: ProviderSearchService[];
}

/**
 * Work 162: what Module 14 indexes about a healthcare provider (module-14 §7). Read-only; Search
 * re-reads a provider through this port on every provider event, so its projection converges.
 */
export interface IProviderSearchSourcePort {
  providerIds(): Promise<string[]>;
  /** `null` when there is no such provider (or it was deleted). */
  provider(providerId: string): Promise<ProviderSearchSource | null>;
}
