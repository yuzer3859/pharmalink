import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetDriverOperationsQuery, ListDriverOperationsQuery } from '../../application/queries/driver-operations.queries';
import { ListDriverOperationsQueryDto } from '../dtos/driver-operations.dto';
import {
  DriverOperationsListResponse,
  DriverOperationsResponse,
  toDriverOperationsListResponse,
  toDriverOperationsResponse,
} from '../dtos/driver-operations.response';

/**
 * Driver operations visibility (module-16 Work 37) — read-only:
 *
 *     GET /admin/operations/drivers                    ?availability &onShift &page &size
 *     GET /admin/operations/drivers/:driverProfileId   one profile's availability, shift and job counts
 *
 * `driver:read:any` — added by this work; ADMIN only, SUPER_ADMIN by wildcard. It grants no driver
 * or delivery action. No user id, name, phone, vehicle plate, service area or position is returned.
 * Not audited.
 */
@Controller('admin/operations/drivers')
@RequirePermissions('driver:read:any')
export class AdminDriverOperationsController {
  constructor(
    private readonly list: ListDriverOperationsQuery,
    private readonly getOne: GetDriverOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListDriverOperationsQueryDto): Promise<DriverOperationsListResponse> {
    return toDriverOperationsListResponse(
      await this.list.execute({
        availability: q.availability,
        onShift: q.onShift === undefined ? undefined : q.onShift === 'true',
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':driverProfileId')
  async detail(@Param('driverProfileId', new ParseUUIDPipe()) driverProfileId: string): Promise<DriverOperationsResponse> {
    return toDriverOperationsResponse(await this.getOne.execute(driverProfileId));
  }
}
