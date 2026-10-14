import { Inject, Injectable } from '@nestjs/common';
import {
  IStockReservationOperationsReadPort,
  STOCK_RESERVATION_OPERATIONS_READ_PORT,
  StockReservationOperationsDetail,
  StockReservationOperationsFilter,
  StockReservationOperationsPage,
} from '../../../pharmacy-inventory/application/ports/inbound/stock-reservation-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_RESERVATION_PAGE = 1;
export const DEFAULT_RESERVATION_PAGE_SIZE = 20;
export const MAX_RESERVATION_PAGE_SIZE = 100;

export interface ListStockReservationOperationsInput extends StockReservationOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/inventory/reservations` (module-16 Work 52): recorded reservations newest
 * first, through Module 04's `STOCK_RESERVATION_OPERATIONS_READ_PORT`. Paging clamped to 1..100
 * (default 20). Every state and flag is Module 04's. Read-only; not audited.
 */
@Injectable()
export class ListStockReservationOperationsQuery {
  constructor(@Inject(STOCK_RESERVATION_OPERATIONS_READ_PORT) private readonly reservations: IStockReservationOperationsReadPort) {}

  execute(input: ListStockReservationOperationsInput): Promise<StockReservationOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_RESERVATION_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_RESERVATION_PAGE_SIZE)
        : DEFAULT_RESERVATION_PAGE_SIZE;
    const filter: StockReservationOperationsFilter = {
      listingId: input.listingId,
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      status: input.status,
      heldPastExpiry: input.heldPastExpiry,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.reservations.listReservations(filter, page, size);
  }
}

/** `GET /admin/operations/inventory/reservations/:reservationId` (module-16 Work 52): one reservation. Unknown → 404. */
@Injectable()
export class GetStockReservationOperationsQuery {
  constructor(@Inject(STOCK_RESERVATION_OPERATIONS_READ_PORT) private readonly reservations: IStockReservationOperationsReadPort) {}

  async execute(reservationId: string): Promise<StockReservationOperationsDetail> {
    const detail = await this.reservations.getReservation(reservationId);
    if (!detail) throw AdminErrors.stockReservationNotFound();
    return detail;
  }
}
