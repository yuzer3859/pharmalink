import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RunSettlementCommand } from '../../application/commands/run-settlement.command';
import {
  GetSettlementQuery,
  ListSettlementsQuery,
} from '../../application/queries/get-settlement.query';
import { ListSettlementsQueryDto, RunSettlementDto } from '../dtos/settlement.dto';
import {
  RunSettlementResponse,
  SettlementDetailResponse,
  SettlementPageResponse,
  toRunSettlementResponse,
  toSettlementDetailResponse,
  toSettlementPageResponse,
} from '../dtos/settlement.response';

/**
 * The finance surface for settlement statements (§9.6): generate one, and read any.
 *
 *     GET  /admin/finance/settlements       list, platform-wide
 *     GET  /admin/finance/settlements/{id}  one statement with its lines
 *     POST /admin/finance/settlements/run   generate a DRAFT statement for one period
 *
 * The two reads close a gap the generation route left behind: finance could cut a statement and
 * then had no way to fetch it again, because `settlement:read:org` is the *provider's* permission
 * and `PermissionsGuard` requires every listed permission rather than any of them. They add no
 * behaviour — the same two queries and the same response mappers `GET /settlements` already uses,
 * called without a provider scope.
 *
 * ## It moves no money, and cannot
 *
 * Generating a statement is **a read of the ledger written down**. It posts no ledger transaction,
 * debits no `PROVIDER_PAYABLE`, changes no balance and calls no payment provider — §11.5's
 * `DEBIT Provider-Payable; CREDIT Gateway-Clearing` belongs to `ExecutePayout`, which needs a
 * payout provider that does not exist in this repository. Recording money as sent before anything
 * can send it is the one unrecoverable mistake available in an append-only ledger, so the route
 * that could do it is deliberately absent rather than stubbed.
 *
 * §9.6's `approve|pay` routes are absent for the same reason, and `ISettlementRepository` has no
 * status-transition method to reach them with.
 *
 * ## Authorization
 *
 * `finance:settlement:any` on the **class**, so every route here inherits it and a new one cannot
 * be added unguarded by forgetting a decorator. It is an existing catalog permission, granted to
 * `FINANCE_OFFICER` alone (and to `SUPER_ADMIN` by wildcard). No permission was invented and none
 * was regranted: `ADMIN` does not hold it today — that is the catalog's existing division between
 * platform administration and finance authority, not a decision taken here — and a pharmacy owner
 * holds only `settlement:read:org`, which reaches `/settlements` and nothing under `/admin`.
 *
 * ## These reads are platform-wide, and deliberately unscoped
 *
 * `/settlements` resolves the caller's own pharmacies and constrains every read to them. These
 * routes must **not** do that: `finance:settlement:any` is platform authority, and a finance
 * officer scoped to the pharmacies they happen to own would see nothing at all. The queries are
 * therefore called with no provider scope, which they take as unrestricted.
 *
 * That is not an id-enumeration hole. An unknown id answers `NOT_FOUND` through the same query and
 * the same error the provider surface uses; what changes is only *who may ask*, and a caller
 * holding platform finance authority is entitled to know whether a statement exists.
 *
 * ## Idempotency
 *
 * The body *is* the idempotency key. `RunSettlementCommand`'s identity is
 * `(pharmacyId, periodStart, periodEnd, currency)` behind a unique index, checked cheaply before
 * its transaction and again inside it, with the index race resolved by returning the winner. A
 * repeated request therefore replays the committed statement, and concurrent identical requests
 * converge on one — without this controller holding any state or comparing any request.
 *
 * No `Idempotency-Key` header is required, deliberately. The command has no parameter for one, so
 * accepting it would either be ignored — advertising a guarantee the code does not implement — or
 * would need a second, weaker mechanism racing the unique index that already does the job. The
 * same reasoning `RequireIdempotencyKey`'s own doc comment gives for keeping replay logic in the
 * commands applies here with the header removed entirely.
 *
 * `200`, not `201`: the response is the statement for this period, whether this call created it or
 * found it. A `201` that a replay could not honestly return would make the status code the one
 * part of the response a client could not rely on.
 */
@Controller('admin/finance/settlements')
@RequirePermissions('finance:settlement:any')
export class AdminSettlementController {
  constructor(
    private readonly runSettlement: RunSettlementCommand,
    private readonly listSettlements: ListSettlementsQuery,
    private readonly getSettlement: GetSettlementQuery,
  ) {}

  /**
   * Every provider's statements, newest period first.
   *
   * The same filters and the same summary fields as `GET /settlements` — `pharmacyId` here is a
   * plain filter with no scope to intersect it with, which is the only difference between the two
   * routes and the whole reason this one exists.
   */
  @Get()
  async list(@Query() query: ListSettlementsQueryDto): Promise<SettlementPageResponse> {
    return toSettlementPageResponse(
      await this.listSettlements.execute({
        // Explicitly unrestricted. Written out rather than omitted so that the absence of a scope
        // is a visible decision here, not something a reader has to infer from a missing field.
        allowedPharmacyIds: null,
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

  /** One statement with its lines, whichever provider it belongs to. */
  @Get(':id')
  async getOne(@Param('id') settlementId: string): Promise<SettlementDetailResponse> {
    return toSettlementDetailResponse(
      await this.getSettlement.execute({ settlementId, pharmacyIds: null }),
    );
  }

  @Post('run')
  @HttpCode(HttpStatus.OK)
  async run(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: RunSettlementDto,
  ): Promise<RunSettlementResponse> {
    return toRunSettlementResponse(
      await this.runSettlement.execute({
        pharmacyId: dto.pharmacyId,
        periodStart: new Date(dto.periodStart),
        periodEnd: new Date(dto.periodEnd),
        currency: dto.currency,
        // Recorded on the `SETTLEMENT_GENERATED` audit entry (§13). A scheduled run passes
        // `null`; an operator-triggered one is attributable to the operator.
        actorUserId: user.userId,
      }),
    );
  }
}

/** `@IsDateString` has already rejected anything unparseable, so this cannot yield `Invalid Date`. */
function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
