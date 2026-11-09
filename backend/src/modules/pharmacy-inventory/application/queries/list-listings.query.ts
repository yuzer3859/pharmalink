import { Inject, Injectable } from '@nestjs/common';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import { IStockLedgerRepository, STOCK_LEDGER_REPOSITORY } from '../../domain/repositories/stock-ledger.repository';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';

export interface ListListingsFilter {
  pharmacyId: string;
  branchId?: string;
  catalogProductId?: string;
  page?: number;
  size?: number;
}

/**
 * `GET /inventory/listings` (module-04 §9.3), scoped to the caller's pharmacy.
 *
 * Work 111: each item also carries `productName` from Module 03 (through `ICatalogPort`), so the
 * pharmacy portal can show what a listing is. Every earlier field is unchanged.
 */
@Injectable()
export class ListListingsQuery {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
  ) {}

  async execute(filter: ListListingsFilter) {
    const { items, total } = await this.listings.findMany({
      pharmacyId: filter.pharmacyId,
      branchId: filter.branchId,
      catalogProductId: filter.catalogProductId,
      page: filter.page ?? 1,
      size: filter.size ?? 20,
    });
    const names = await productNames(this.catalog, items.map((l) => l.toProps().catalogProductId));
    return {
      items: items.map((l) => {
        const props = l.toProps();
        return { ...props, productName: names.get(props.catalogProductId) ?? null };
      }),
      total,
      page: filter.page ?? 1,
      size: filter.size ?? 20,
    };
  }
}

/**
 * Work 111: `GET /inventory/listings/:id`, one listing of the caller's pharmacy with its product
 * name and its batches (soonest expiry first), which receiving and adjusting stock need. Another
 * pharmacy's listing, or a deleted one, reads as not found.
 */
@Injectable()
export class GetListingQuery {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
  ) {}

  async execute(input: { pharmacyId: string; listingId: string }) {
    const listing = await this.listings.findById(input.listingId);
    const props = listing?.toProps();
    if (!props || props.pharmacyId !== input.pharmacyId || props.deletedAt) {
      throw PharmacyInventoryErrors.listingNotFound();
    }
    const [batches, product] = await Promise.all([
      this.ledger.findBatchesByListing(props.id),
      this.catalog.getProduct(props.catalogProductId),
    ]);
    return {
      ...props,
      productName: product?.name ?? null,
      batches: [...batches].sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime()),
    };
  }
}

async function productNames(catalog: ICatalogPort, productIds: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(productIds)];
  const views = await Promise.all(unique.map((id) => catalog.getProduct(id)));
  return new Map(unique.map((id, i) => [id, views[i]?.name ?? null]));
}
