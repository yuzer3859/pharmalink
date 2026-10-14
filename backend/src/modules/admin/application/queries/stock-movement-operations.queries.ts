import { Inject, Injectable } from '@nestjs/common';
import {
  IStockMovementOperationsReadPort,
  STOCK_MOVEMENT_OPERATIONS_READ_PORT,
  StockMovementOperationsFilter,
  StockMovementOperationsPage,
  StockMovementOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/stock-movement-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_STOCK_MOVEMENT_PAGE = 1;
export const DEFAULT_STOCK_MOVEMENT_PAGE_SIZE = 20;
export const MAX_STOCK_MOVEMENT_PAGE_SIZE = 100;

export interface ListStockMovementOperationsInput extends StockMovementOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/inventory/movements` (module-16 Work 50): recorded stock movements newest
 * first, through Module 04's `STOCK_MOVEMENT_OPERATIONS_READ_PORT`. Paging clamped to 1..100
 * (default 20). History only — no balance is computed here. Read-only; not audited.
 */
@Injectable()
export class ListStockMovementOperationsQuery {
  constructor(@Inject(STOCK_MOVEMENT_OPERATIONS_READ_PORT) private readonly movements: IStockMovementOperationsReadPort) {}

  execute(input: ListStockMovementOperationsInput): Promise<StockMovementOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_STOCK_MOVEMENT_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_STOCK_MOVEMENT_PAGE_SIZE)
        : DEFAULT_STOCK_MOVEMENT_PAGE_SIZE;
    const filter: StockMovementOperationsFilter = {
      listingId: input.listingId,
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      batchId: input.batchId,
      type: input.type,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.movements.listMovements(filter, page, size);
  }
}

/** `GET /admin/operations/inventory/movements/:movementId` (module-16 Work 50): one recorded movement. Unknown → 404. */
@Injectable()
export class GetStockMovementOperationsQuery {
  constructor(@Inject(STOCK_MOVEMENT_OPERATIONS_READ_PORT) private readonly movements: IStockMovementOperationsReadPort) {}

  async execute(movementId: string): Promise<StockMovementOperationsView> {
    const movement = await this.movements.getMovement(movementId);
    if (!movement) throw AdminErrors.stockMovementNotFound();
    return movement;
  }
}
