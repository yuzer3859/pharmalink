import { authService, type SessionRequest } from './auth.service';

/** Work 157: a pharmacy owner and what they own. */
export interface PharmacyOwner {
  userId: string;
  email: string | null;
  phone: string | null;
  status: string;
  createdAt: string;
  pharmacyCount: number;
  organizations: Array<{ organizationId: string; name: string; status: string }>;
}

export interface OwnedPharmacy {
  organizationId: string;
  name: string;
  organizationStatus: string;
  pharmacyId: string | null;
  transactingStatus: string | null;
}

export interface PharmacyOwnerRecord extends Omit<PharmacyOwner, 'pharmacyCount' | 'organizations'> {
  pharmacies: OwnedPharmacy[];
}

export interface OwnerChange {
  account: { previousStatus: string; status: string };
  pharmacies: Array<{ pharmacyId: string; outcome: 'disabled' | 'already disabled' | 'enabled' | 'not enabled'; reason?: string }>;
}

export function ownerQuery(filters: { identifier?: string; status?: string; page?: number; size?: number }): string {
  const params = new URLSearchParams();
  if (filters.identifier?.trim() && filters.identifier.trim().length >= 3) params.set('identifier', filters.identifier.trim());
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** In words, what happened to each pharmacy when its owner was disabled or enabled. */
export function ownerChangeSummary(change: OwnerChange, names: Map<string, string>): string {
  if (change.pharmacies.length === 0) return '';
  return change.pharmacies
    .map((p) => `${names.get(p.pharmacyId) ?? 'A pharmacy'}: ${p.outcome}${p.reason ? ` (${p.reason})` : ''}`)
    .join('; ');
}

export function createPharmacyOwnersService(request: SessionRequest) {
  const owner = (id: string) => `/admin/pharmacy-owners/${encodeURIComponent(id)}`;
  return {
    list(filters: { identifier?: string; status?: string; page?: number; size?: number } = {}): Promise<{ items: PharmacyOwner[]; total: number; page: number; size: number }> {
      return request(`/admin/pharmacy-owners${ownerQuery(filters)}`, { method: 'GET' });
    },
    get(userId: string): Promise<PharmacyOwnerRecord> {
      return request<PharmacyOwnerRecord>(owner(userId), { method: 'GET' });
    },
    disable(userId: string, reason: string, alsoPharmacies: boolean): Promise<OwnerChange> {
      return request<OwnerChange>(`${owner(userId)}/disable`, { method: 'POST', body: { reason: reason.trim(), alsoPharmacies } });
    },
    enable(userId: string, alsoPharmacies: boolean): Promise<OwnerChange> {
      return request<OwnerChange>(`${owner(userId)}/enable`, { method: 'POST', body: { alsoPharmacies } });
    },
  };
}

export const pharmacyOwnersService = createPharmacyOwnersService(authService.request);
