import type { PortalKey } from '@/types';

// Data-access scope derived from the authenticated user + active portal.
// Pharmacy portal is limited to a single pharmacy; admin/superadmin see all.
export interface DataScope {
  portal: PortalKey;
  pharmacyId?: string;
}

export const scopedToPharmacy = (scope: DataScope) =>
  scope.portal === 'pharmacy' && !!scope.pharmacyId;
