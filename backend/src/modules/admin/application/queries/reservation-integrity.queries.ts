import { Inject, Injectable } from '@nestjs/common';
import {
  IReservationIntegrityReadPort,
  RESERVATION_INTEGRITY_READ_PORT,
  ReservationIntegrityFilter,
  ReservationIntegrityPage,
  ReservationIntegritySummary,
} from '../../../pharmacy-inventory/application/ports/inbound/reservation-integrity-read.port';

export const DEFAULT_INTEGRITY_PAGE = 1;
export const DEFAULT_INTEGRITY_PAGE_SIZE = 20;
export const MAX_INTEGRITY_PAGE_SIZE = 100;

export interface ListReservationIntegrityInput extends ReservationIntegrityFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/inventory/reservation-integrity` (module-16 Work 54): live listings whose stored
 * `reserved` differs from the reservation-derived counter, through Module 04's
 * `RESERVATION_INTEGRITY_READ_PORT` (the accounting rule is Module 04's). Paging clamped to 1..100
 * (default 20). Detection only; not audited.
 */
@Injectable()
export class ListReservationIntegrityQuery {
  constructor(@Inject(RESERVATION_INTEGRITY_READ_PORT) private readonly integrity: IReservationIntegrityReadPort) {}

  execute(input: ListReservationIntegrityInput): Promise<ReservationIntegrityPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_INTEGRITY_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_INTEGRITY_PAGE_SIZE)
        : DEFAULT_INTEGRITY_PAGE_SIZE;
    return this.integrity.listDiscrepancies({ pharmacyId: input.pharmacyId, branchId: input.branchId }, page, size);
  }
}

/** `GET /admin/operations/inventory/reservation-integrity/summary` (module-16 Work 54): class counts only. */
@Injectable()
export class GetReservationIntegritySummaryQuery {
  constructor(@Inject(RESERVATION_INTEGRITY_READ_PORT) private readonly integrity: IReservationIntegrityReadPort) {}

  execute(filter: ReservationIntegrityFilter): Promise<ReservationIntegritySummary> {
    return this.integrity.getSummary({ pharmacyId: filter.pharmacyId, branchId: filter.branchId });
  }
}
