import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetPharmacyOperationsQuery, ListPharmacyOperationsQuery } from '../../application/queries/pharmacy-operations.queries';
import { ListPharmacyOperationsQueryDto } from '../dtos/pharmacy-operations.dto';
import {
  PharmacyOperationsListResponse,
  PharmacyOperationsResponse,
  toPharmacyOperationsListResponse,
  toPharmacyOperationsResponse,
} from '../dtos/pharmacy-operations.response';

/**
 * Pharmacy operations visibility (module-16 Work 47) — read-only:
 *
 *     GET /admin/operations/pharmacies               ?transactingStatus &eligible &hasPurchasableInventory &createdFrom &createdTo &page &size
 *     GET /admin/operations/pharmacies/:pharmacyId   one live pharmacy
 *
 * `pharmacy:read:any` — added by this work; ADMIN only, SUPER_ADMIN by wildcard. It grants no pharmacy,
 * licence, branch, listing or stock action. The id is UUID-validated, so no reserved segment can be read
 * as one. Not audited.
 */
@Controller('admin/operations/pharmacies')
@RequirePermissions('pharmacy:read:any')
export class AdminPharmacyOperationsController {
  constructor(
    private readonly list: ListPharmacyOperationsQuery,
    private readonly getOne: GetPharmacyOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListPharmacyOperationsQueryDto): Promise<PharmacyOperationsListResponse> {
    const flag = (v?: 'true' | 'false') => (v === undefined ? undefined : v === 'true');
    return toPharmacyOperationsListResponse(
      await this.list.execute({
        transactingStatus: q.transactingStatus,
        eligible: flag(q.eligible),
        hasPurchasableInventory: flag(q.hasPurchasableInventory),
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':pharmacyId')
  async detail(@Param('pharmacyId', new ParseUUIDPipe()) pharmacyId: string): Promise<PharmacyOperationsResponse> {
    return toPharmacyOperationsResponse(await this.getOne.execute(pharmacyId));
  }
}
