import { Inject, Injectable } from '@nestjs/common';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';

export interface ListListingsFilter {
  pharmacyId: string;
  branchId?: string;
  catalogProductId?: string;
  page?: number;
  size?: number;
}

/** `GET /inventory/listings` (module-04 §10.2). */
@Injectable()
export class ListListingsQuery {
  constructor(@Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository) {}

  async execute(filter: ListListingsFilter) {
    const { items, total } = await this.listings.findMany({
      pharmacyId: filter.pharmacyId,
      branchId: filter.branchId,
      catalogProductId: filter.catalogProductId,
      page: filter.page ?? 1,
      size: filter.size ?? 20,
    });
    return {
      items: items.map((l) => l.toProps()),
      total,
      page: filter.page ?? 1,
      size: filter.size ?? 20,
    };
  }
}
