import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { adminInventoryService, type AdminListingFilters } from '@/services/adminInventory.service';

export function useAdminListings(filters: AdminListingFilters) {
  return useQuery({
    queryKey: ['admin-listings', filters] as const,
    queryFn: () => adminInventoryService.list(filters),
    placeholderData: keepPreviousData,
  });
}

export function useAdminListing(listingId: string | null) {
  return useQuery({
    queryKey: ['admin-listings', 'detail', listingId] as const,
    queryFn: () => adminInventoryService.get(listingId as string),
    enabled: !!listingId,
  });
}
