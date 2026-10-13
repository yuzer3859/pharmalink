import { Controller, Get } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetCodExceptionSummaryQuery } from '../../application/queries/get-cod-exception-summary.query';
import { CodExceptionSummaryResponse, toCodExceptionSummaryResponse } from '../dtos/cod-exception-summary.response';

/**
 * COD exception and aging summary (module-16 Work 39) — read-only:
 *
 *     GET /admin/operations/cod/summary
 *
 * A controller of its own, registered in `AdminModule` **before** `AdminCodOperationsController`, so
 * `summary` reaches this route rather than Work 38's `:collectionId` (whose UUID pipe would refuse
 * it). `finance:report:any`, as Work 38. Counts and timestamps only. Not audited.
 */
@Controller('admin/operations/cod/summary')
@RequirePermissions('finance:report:any')
export class AdminCodSummaryController {
  constructor(private readonly summary: GetCodExceptionSummaryQuery) {}

  @Get()
  async get(): Promise<CodExceptionSummaryResponse> {
    return toCodExceptionSummaryResponse(await this.summary.execute());
  }
}
