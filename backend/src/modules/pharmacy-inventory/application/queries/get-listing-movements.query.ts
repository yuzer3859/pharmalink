import { Inject, Injectable } from '@nestjs/common';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IListingRepository, LISTING_REPOSITORY } from '../../domain/repositories/listing.repository';
import {
  IStockLedgerRepository,
  STOCK_LEDGER_REPOSITORY,
} from '../../domain/repositories/stock-ledger.repository';

/** `GET /inventory/listings/:id/movements` — paginated ledger view (module-04 §10.2). */
@Injectable()
export class GetListingMovementsQuery {
  constructor(
    @Inject(LISTING_REPOSITORY) private readonly listings: IListingRepository,
    @Inject(STOCK_LEDGER_REPOSITORY) private readonly ledger: IStockLedgerRepository,
  ) {}

  async execute(pharmacyId: string, listingId: string, page = 1, size = 20) {
    const listing = await this.listings.findById(listingId);
    if (!listing || listing.toProps().pharmacyId !== pharmacyId) {
      throw PharmacyInventoryErrors.listingNotFound();
    }
    return this.ledger.listMovements(listingId, page, size);
  }
}
