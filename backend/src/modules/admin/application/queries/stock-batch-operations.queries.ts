import { Inject, Injectable } from '@nestjs/common';
import {
  IStockBatchOperationsReadPort,
  STOCK_BATCH_OPERATIONS_READ_PORT,
  StockBatchOperationsDetail,
  StockBatchOperationsFilter,
  StockBatchOperationsPage,
} from '../../../pharmacy-inventory/application/ports/inbound/stock-batch-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_STOCK_BATCH_PAGE = 1;
export const DEFAULT_STOCK_BATCH_PAGE_SIZE = 20;
export const MAX_STOCK_BATCH_PAGE_SIZE = 100;

export interface ListStockBatchOperationsInput extends StockBatchOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/inventory/batches` (module-16 Work 51): stock batches of live listings,
 * soonest expiry first, through Module 04's `STOCK_BATCH_OPERATIONS_READ_PORT`. Paging clamped to
 * 1..100 (default 20). Expiry is Module 04's rule at one `generatedAt`. Read-only; not audited.
 */
@Injectable()
export class ListStockBatchOperationsQuery {
  constructor(@Inject(STOCK_BATCH_OPERATIONS_READ_PORT) private readonly batches: IStockBatchOperationsReadPort) {}

  execute(input: ListStockBatchOperationsInput): Promise<StockBatchOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_STOCK_BATCH_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_STOCK_BATCH_PAGE_SIZE)
        : DEFAULT_STOCK_BATCH_PAGE_SIZE;
    const filter: StockBatchOperationsFilter = {
      listingId: input.listingId,
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      catalogProductId: input.catalogProductId,
      expiresFrom: input.expiresFrom,
      expiresTo: input.expiresTo,
      isExpired: input.isExpired,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.batches.listBatches(filter, page, size);
  }
}

/** `GET /admin/operations/inventory/batches/:batchId` (module-16 Work 51): one batch of a live listing. Unknown → 404. */
@Injectable()
export class GetStockBatchOperationsQuery {
  constructor(@Inject(STOCK_BATCH_OPERATIONS_READ_PORT) private readonly batches: IStockBatchOperationsReadPort) {}

  async execute(batchId: string): Promise<StockBatchOperationsDetail> {
    const detail = await this.batches.getBatch(batchId);
    if (!detail) throw AdminErrors.stockBatchNotFound();
    return detail;
  }
}
