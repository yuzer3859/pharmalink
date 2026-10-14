import { Inject, Injectable } from '@nestjs/common';
import {
  IInventoryListingOperationsReadPort,
  INVENTORY_LISTING_OPERATIONS_READ_PORT,
  InventoryListingOperationsDetail,
  InventoryListingOperationsFilter,
  InventoryListingOperationsPage,
} from '../../../pharmacy-inventory/application/ports/inbound/inventory-listing-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_LISTING_OPERATIONS_PAGE = 1;
export const DEFAULT_LISTING_OPERATIONS_PAGE_SIZE = 20;
export const MAX_LISTING_OPERATIONS_PAGE_SIZE = 100;

export interface ListInventoryListingOperationsInput extends InventoryListingOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/inventory/listings` (module-16 Work 49): live listings newest first, with
 * stored and computed sellable stock and Work 26's purchasability, through Module 04's
 * `INVENTORY_LISTING_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20). Read-only.
 */
@Injectable()
export class ListInventoryListingOperationsQuery {
  constructor(@Inject(INVENTORY_LISTING_OPERATIONS_READ_PORT) private readonly listings: IInventoryListingOperationsReadPort) {}

  execute(input: ListInventoryListingOperationsInput): Promise<InventoryListingOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_LISTING_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_LISTING_OPERATIONS_PAGE_SIZE)
        : DEFAULT_LISTING_OPERATIONS_PAGE_SIZE;
    const filter: InventoryListingOperationsFilter = {
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      catalogProductId: input.catalogProductId,
      isEnabled: input.isEnabled,
      hasStoredSellableStock: input.hasStoredSellableStock,
      customerPurchasable: input.customerPurchasable,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.listings.listListings(filter, page, size);
  }
}

/** `GET /admin/operations/inventory/listings/:listingId` (module-16 Work 49): one live listing. Unknown or deleted → 404. */
@Injectable()
export class GetInventoryListingOperationsQuery {
  constructor(@Inject(INVENTORY_LISTING_OPERATIONS_READ_PORT) private readonly listings: IInventoryListingOperationsReadPort) {}

  async execute(listingId: string): Promise<InventoryListingOperationsDetail> {
    const listing = await this.listings.getListing(listingId);
    if (!listing) throw AdminErrors.inventoryListingNotFound();
    return listing;
  }
}
