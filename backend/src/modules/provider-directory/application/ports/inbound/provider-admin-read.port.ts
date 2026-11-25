import type { ProviderStatus, ProviderType } from '../../../domain/provider-rules';

export const PROVIDER_ADMIN_READ_PORT = Symbol('PROVIDER_ADMIN_READ_PORT');

export interface ProviderListItem {
  providerId: string;
  organizationId: string;
  type: ProviderType;
  displayName: string;
  status: ProviderStatus;
  licenseStatus: string;
  licenseExpiresAt: Date | null;
  city: string | null;
  createdAt: Date;
}

export interface ProviderRecord extends ProviderListItem {
  nameEn: string | null;
  nameAm: string | null;
  description: string | null;
  website: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  ratingAvg: number;
  ratingCount: number;
  locations: Array<{
    locationId: string;
    name: string;
    city: string | null;
    subcity: string | null;
    addressLine: string | null;
    lat: number | null;
    lng: number | null;
    phone: string | null;
    emergencyAvailability: string;
    isPrimary: boolean;
    isActive: boolean;
  }>;
  departments: Array<{ departmentId: string; name: string; specialty: string | null; isActive: boolean }>;
  services: Array<{ serviceId: string; type: string; name: string; price: number | null; currency: string; isAvailable: boolean }>;
}

/** Work 160: the Super Admin's view of healthcare providers (module-09 §8.3). Read-only. */
export interface IProviderAdminReadPort {
  list(
    filter: { q?: string; type?: ProviderType; status?: ProviderStatus },
    page: number,
    size: number,
  ): Promise<{ items: ProviderListItem[]; total: number }>;
  /** `null` when there is no live provider with this id. */
  get(providerId: string): Promise<ProviderRecord | null>;
}
