import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AccountingReconciliationService } from '../../application/services/accounting-reconciliation.service';
import { GetReconciliationQueryDto } from '../dtos/reconciliation.dto';
import {
  ReconciliationReportResponse,
  toReconciliationResponse,
} from '../dtos/reconciliation.response';

/**
 * Accounting reconciliation (§9.6 — `GET /admin/finance/reconciliation`, §3.6 F-REC-01).
 *
 * ## Read-only, structurally
 *
 * One `@Get`, and the service behind it writes nothing: not a correcting entry, not a status
 * change, not a cached-balance refresh. There is no repair route here and there is not going to be
 * one from this task — every anomaly below means the accounting already disagrees with itself, and
 * an automated fix would be a guess about which side is right, written into an append-only ledger
 * where it can never be withdrawn. A human decides; the correction is an explicit adjustment
 * posting with its own approval rules.
 *
 * Repeating the call is therefore free of consequence, which is what makes it safe to poll from a
 * dashboard or an alert.
 *
 * ## It reports what the service found, and computes nothing of its own
 *
 * The controller calls `AccountingReconciliationService.run()` and maps the report. It re-derives
 * no payable, re-checks no invariant, and adds no anomaly of its own. If a check is missing, it is
 * missing from the service — which is the only place it could be fixed without HTTP becoming a
 * second opinion on what "reconciled" means.
 *
 * ## Authorization
 *
 * `finance:report:any` — already in the RBAC catalog, already granted to `FINANCE_OFFICER` and
 * `ADMIN` (and to `SUPER_ADMIN` by wildcard), and already what §9.6 assigns to this route. No
 * permission was invented and no grant was changed. It is platform-wide by design: a pharmacy
 * owner's `settlement:read:org` does not reach here, and should not — a ledger imbalance or a
 * duplicated statement is a platform fact, and showing one provider a partial view of it would be
 * worse than showing them nothing.
 *
 * Errors are not caught. A discrepancy is the *output*, not an exception; anything that does throw
 * is already an `ApiException` and the global `AllExceptionsFilter` maps it.
 */
@Controller('admin/finance/reconciliation')
export class AdminReconciliationController {
  constructor(private readonly reconciliation: AccountingReconciliationService) {}

  @Get()
  @RequirePermissions('finance:report:any')
  async get(
    @Query() query: GetReconciliationQueryDto,
  ): Promise<ReconciliationReportResponse> {
    const options = { pharmacyId: query.pharmacyId, limit: query.limit };
    return toReconciliationResponse(await this.reconciliation.run(options), options);
  }
}
