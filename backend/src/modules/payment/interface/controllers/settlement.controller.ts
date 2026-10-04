import { Controller, Get, Param, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  GetSettlementQuery,
  ListSettlementsQuery,
} from '../../application/queries/get-settlement.query';
import { ProviderScopeService } from '../../application/services/provider-scope.service';
import { ListSettlementsQueryDto } from '../dtos/settlement.dto';
import {
  SettlementDetailResponse,
  SettlementPageResponse,
  toSettlementDetailResponse,
  toSettlementPageResponse,
} from '../dtos/settlement.response';

/**
 * A provider's own settlement statements (§9.6 — "`GET /settlements` — provider's own statements
 * (Pharmacy Owner: `settlement:read:org`)").
 *
 * **Read-only, and structurally so.** Both routes are `@Get`. There is no approve route, no pay
 * route and no run route here; §9.6's `approve|pay` need a payout provider that does not exist,
 * and generation is an administrative action that lives on the finance surface.
 *
 * ## It computes nothing
 *
 * Every figure returned was derived from the immutable ledger when the statement was generated
 * and has been stored since. This controller does not compute a provider payable, a platform fee
 * or a coupon discount; it does not read `account_balances`; it does not touch the ledger at all.
 * It maps HTTP to two queries and an allow-listed response, and that is the whole of it — which
 * is what makes "what the pharmacy sees" and "what the ledger says" the same statement rather
 * than two calculations that agree today.
 *
 * ## Scope
 *
 * `settlement:read:org` establishes *that* the caller may read provider statements. **Which**
 * provider's is answered below this boundary, from the access token alone: `ProviderScopeService`
 * resolves the caller's organizations and then the pharmacies those organizations own, and both
 * routes are constrained to that set. No route, DTO or body accepts an organization id, and the
 * one `pharmacyId` a client may send is a filter intersected with the resolved set — so naming
 * another provider's pharmacy yields an empty page, never their statements.
 *
 * A statement belonging to another provider answers `NOT_FOUND`, not `FORBIDDEN` — the same
 * no-existence-leakage discipline used elsewhere, so statement ids cannot be probed. An owner who
 * belongs to no organization, or whose organizations own no pharmacy, gets an empty page rather
 * than an error: they are authorized to call the route and simply own nothing.
 *
 * Errors are not caught. Every failure is already an `ApiException` and the global
 * `AllExceptionsFilter` maps it.
 */
@Controller('settlements')
@RequirePermissions('settlement:read:org')
export class SettlementController {
  constructor(
    private readonly listSettlements: ListSettlementsQuery,
    private readonly getSettlement: GetSettlementQuery,
    private readonly scope: ProviderScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: ListSettlementsQueryDto,
  ): Promise<SettlementPageResponse> {
    return toSettlementPageResponse(
      await this.listSettlements.execute({
        allowedPharmacyIds: await this.scope.resolvePharmacyIds(user.userId),
        pharmacyId: query.pharmacyId,
        currency: query.currency,
        status: query.status,
        from: toDate(query.from),
        to: toDate(query.to),
        page: query.page,
        size: query.size,
      }),
    );
  }

  /**
   * The statement plus its lines. Each line names the `ledger_transactions.reference` it reports
   * (`CAPTURE-<paymentId>` / `REFUND-<refundId>`), so a provider disputing a figure can be pointed
   * at the posting it came from rather than at a recomputation.
   */
  @Get(':id')
  async getOne(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') settlementId: string,
  ): Promise<SettlementDetailResponse> {
    return toSettlementDetailResponse(
      await this.getSettlement.execute({
        settlementId,
        pharmacyIds: await this.scope.resolvePharmacyIds(user.userId),
      }),
    );
  }
}

/** `@IsDateString` has already rejected anything unparseable, so this cannot yield `Invalid Date`. */
function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
