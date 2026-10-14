import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetBranchOperationsQuery, ListBranchOperationsQuery } from '../../application/queries/branch-operations.queries';
import { ListBranchOperationsQueryDto } from '../dtos/branch-operations.dto';
import {
  BranchOperationsListResponse,
  BranchOperationsResponse,
  toBranchOperationsListResponse,
  toBranchOperationsResponse,
} from '../dtos/branch-operations.response';

/**
 * Branch operations visibility (module-16 Work 48) — read-only:
 *
 *     GET /admin/operations/branches             ?pharmacyId &isActive &hasPurchasableInventory &createdFrom &createdTo &page &size
 *     GET /admin/operations/branches/:branchId   one live branch of a live pharmacy
 *
 * `pharmacy:read:any`, as Work 47. The id is UUID-validated, so no reserved segment can be read as
 * one. Not audited.
 */
@Controller('admin/operations/branches')
@RequirePermissions('pharmacy:read:any')
export class AdminBranchOperationsController {
  constructor(
    private readonly list: ListBranchOperationsQuery,
    private readonly getOne: GetBranchOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListBranchOperationsQueryDto): Promise<BranchOperationsListResponse> {
    const flag = (v?: 'true' | 'false') => (v === undefined ? undefined : v === 'true');
    return toBranchOperationsListResponse(
      await this.list.execute({
        pharmacyId: q.pharmacyId,
        isActive: flag(q.isActive),
        hasPurchasableInventory: flag(q.hasPurchasableInventory),
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':branchId')
  async detail(@Param('branchId', new ParseUUIDPipe()) branchId: string): Promise<BranchOperationsResponse> {
    return toBranchOperationsResponse(await this.getOne.execute(branchId));
  }
}
