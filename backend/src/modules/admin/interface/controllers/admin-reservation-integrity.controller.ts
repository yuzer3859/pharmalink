import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import {
  GetReservationIntegritySummaryQuery,
  ListReservationIntegrityQuery,
} from '../../application/queries/reservation-integrity.queries';
import { ListReservationIntegrityQueryDto, ReservationIntegrityScopeDto } from '../dtos/reservation-integrity.dto';
import {
  ReservationIntegrityListResponse,
  ReservationIntegritySummaryResponse,
  toReservationIntegrityListResponse,
  toReservationIntegritySummaryResponse,
} from '../dtos/reservation-integrity.response';

/**
 * Inventory reservation consistency diagnostics (module-16 Work 54) — read-only, detection only:
 *
 *     GET /admin/operations/inventory/reservation-integrity           ?pharmacyId &branchId &page &size
 *     GET /admin/operations/inventory/reservation-integrity/summary   ?pharmacyId &branchId
 *
 * `pharmacy:read:any`, as Works 47–52. Both paths are static — there is no `:id` route under this
 * prefix, so `summary` can never be read as an id. Nothing is repaired, released or expired. Not audited.
 */
@Controller('admin/operations/inventory/reservation-integrity')
@RequirePermissions('pharmacy:read:any')
export class AdminReservationIntegrityController {
  constructor(
    private readonly list: ListReservationIntegrityQuery,
    private readonly summary: GetReservationIntegritySummaryQuery,
  ) {}

  @Get()
  async discrepancies(@Query() q: ListReservationIntegrityQueryDto): Promise<ReservationIntegrityListResponse> {
    return toReservationIntegrityListResponse(
      await this.list.execute({ pharmacyId: q.pharmacyId, branchId: q.branchId, page: q.page, size: q.size }),
    );
  }

  @Get('summary')
  async totals(@Query() q: ReservationIntegrityScopeDto): Promise<ReservationIntegritySummaryResponse> {
    return toReservationIntegritySummaryResponse(await this.summary.execute({ pharmacyId: q.pharmacyId, branchId: q.branchId }));
  }
}
