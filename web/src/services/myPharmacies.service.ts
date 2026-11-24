import { authService, type SessionRequest } from './auth.service';

/** Work 155: a pharmacy the signed-in account works in. */
export interface MyPharmacy {
  pharmacyId: string;
  /** Chosen with `selectOrganization` and sent as `X-Organization-Id`. */
  organizationId: string;
  displayName: string;
  transactingStatus: string;
}

export function createMyPharmaciesService(request: SessionRequest) {
  return {
    /** `GET /pharmacy/mine`: every pharmacy the account works in, by name. */
    list(): Promise<MyPharmacy[]> {
      return request<MyPharmacy[]>('/pharmacy/mine', { method: 'GET' });
    },
  };
}

export const myPharmaciesService = createMyPharmaciesService(authService.request);
