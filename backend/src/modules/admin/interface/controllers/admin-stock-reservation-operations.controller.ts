import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import {
  GetStockReservationOperationsQuery,
  ListStockReservationOperationsQuery,
} from '../../application/queries/stock-reservation-operations.queries';
import { ListStockReservationOperationsQueryDto } from '../dtos/stock-reservation-operations.dto';
import {
  StockReservationOperationsDetailResponse,
  StockReservationOperationsListResponse,
  toStockReservationOperationsDetailResponse,
  toStockReservationOperationsListResponse,
} from '../dtos/stock-reservation-operations.response';

/**
 * Inventory reservation visibility (module-16 Work 52) — read-only:
 *
 *     GET /admin/operations/inventory/reservations                  ?listingId &pharmacyId &branchId &status &heldPastExpiry
 *                                                                   &createdFrom &createdTo &page &size
 *     GET /admin/operations/inventory/reservations/:reservationId   one reservation
 *
 * `pharmacy:read:any`, as Works 47–51. The id is UUID-validated, so no reserved segment can be read as
 * one. Reading never expires, releases or confirms anything. Not audited.
 */
@Controller('admin/operations/inventory/reservations')
@RequirePermissions('pharmacy:read:any')
export class AdminStockReservationOperationsController {
  constructor(
    private readonly list: ListStockReservationOperationsQuery,
    private readonly getOne: GetStockReservationOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListStockReservationOperationsQueryDto): Promise<StockReservationOperationsListResponse> {
    return toStockReservationOperationsListResponse(
      await this.list.execute({
        listingId: q.listingId,
        pharmacyId: q.pharmacyId,
        branchId: q.branchId,
        status: q.status,
        heldPastExpiry: q.heldPastExpiry === undefined ? undefined : q.heldPastExpiry === 'true',
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':reservationId')
  async detail(@Param('reservationId', new ParseUUIDPipe()) reservationId: string): Promise<StockReservationOperationsDetailResponse> {
    return toStockReservationOperationsDetailResponse(await this.getOne.execute(reservationId));
  }
}
