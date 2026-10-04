import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ReconcileCodCollectionCommand } from '../../application/commands/reconcile-cod-collection.command';
import { RecordCodRemittanceCommand } from '../../application/commands/record-cod-remittance.command';
import { ListCodCollectionsQuery } from '../../application/queries/list-cod-collections.query';
import {
  ListCodCollectionsQueryDto,
  ReconcileCodCollectionDto,
  RecordCodRemittanceDto,
} from '../dtos/cod-remittance.dto';
import {
  CodReconciliationDetailResponse,
  CodReconciliationPageResponse,
  ReconcileCodCollectionResponse,
  RecordCodRemittanceResponse,
  toCodReconciliationDetailResponse,
  toCodReconciliationPageResponse,
  CodCollectionSummaryResponse,
  toCodCollectionSummaryResponse,
  toReconcileCodCollectionResponse,
  toRecordCodRemittanceResponse,
} from '../dtos/cod-remittance.response';

/**
 * The PharmaLink side of cash on delivery (§3.5 F-COD-01, §9.5's
 * `GET /admin/delivery/cod-reconciliation`, the design's Open Question 5).
 *
 *     GET  /admin/delivery/cod-reconciliation                       the queue, filtered
 *     GET  /admin/delivery/cod-reconciliation/{collectionId}        one collection, all three legs
 *     POST /admin/delivery/cod-reconciliation/{id}/remit            confirm the handover
 *     POST /admin/delivery/cod-reconciliation/{id}/reconcile        record the finding
 *
 * ## Separation of duties, expressed in the URL as well as in the guard
 *
 * The COD work left a note on `CodCollectionController` explaining why it carried no remittance
 * route: the only actor with a route near that aggregate is **the driver holding the cash**, and a
 * reconcile verb on `/delivery/jobs/{id}/...` would sit one refactor away from a collection channel
 * certifying its own remittance. That reasoning has not changed, so these four routes are not there.
 *
 * `/delivery/jobs/...` is this module's **driver** surface — every route on it resolves a
 * `driver_profiles.id` from the caller's token and requires the job to name it. A finance officer
 * has no driver profile, so that scoping model does not merely fail to apply to them, it cannot.
 * These routes address a **collection** rather than a job, because a real handover is one channel
 * remitting a day's collections at once and a job id is the wrong handle for it.
 *
 * §9.5 of the approved design names `GET /admin/delivery/cod-reconciliation` exactly, which is the
 * read below; the three that surround it are grouped with it rather than scattered, so that
 * everything a PharmaLink operator may do with COD cash is one guarded file.
 *
 * ## Authorization: two existing permissions, and no new one
 *
 * | Route | Permission | Held by |
 * | --- | --- | --- |
 * | the two reads | `finance:report:any` | `FINANCE_OFFICER`, `ADMIN` |
 * | remit, reconcile | `finance:settlement:any` | `FINANCE_OFFICER` |
 *
 * Both are existing catalogue keys — **no permission was invented and none was regranted**. The
 * split is the substantive decision: an administrator can *see* the platform's COD position, which
 * is an oversight need, but cannot assert that money arrived, which is a cash-handling
 * responsibility the catalogue already gives to finance alone. `ADMIN` not holding
 * `finance:settlement:any` is the catalogue's existing division between platform administration and
 * finance authority, not something decided here.
 *
 * **No `DRIVER` role holds either key.** A driver posting to `/remit` gets a `403` from the guard
 * before any code in this module runs, which is §2's requirement — and it is a property of the
 * catalogue rather than of a check somebody remembered to write.
 *
 * The permissions are per-route rather than on the class, which departs from
 * `AdminSettlementController`'s pattern deliberately: the whole point of this surface is that read
 * authority and write authority differ, and `PermissionsGuard` requires **every** listed permission,
 * so a class-level `finance:settlement:any` would silently lock administrators out of the read the
 * design gives them. Every route below carries its own decorator; none is left unguarded.
 *
 * ## Platform-scoped, deliberately
 *
 * These reads are not narrowed to an organization, the same position `AdminSettlementController`
 * takes. COD cash is owed by a delivery channel to PharmaLink, not to a pharmacy, so there is no
 * organization to scope it to — the pharmacy's side of the money is a Module 07 settlement computed
 * from the order. An unknown id answers `NOT_FOUND` through the same error the driver-facing read
 * uses.
 *
 * ## What is deliberately absent
 *
 * No `PATCH`, no `PUT`, no `DELETE` — on any of the three tables (§8, §21). Nothing here can change
 * a collected amount, a collection method, a remitted amount or a recorded finding, and nothing can
 * remove a reconciliation. A correction is a later auditable adjustment under a workflow that
 * decides who may make one; this work establishes the seam and does not build the dispute system.
 *
 * No Telebirr call, no National Bank call, no receipt verification, no provider webhook — for
 * `ELECTRONIC` collections the `providerReference` is carried through as supplied evidence and
 * nothing in this repository can check it yet (§9).
 *
 * No ledger, payable, settlement or payout route, because Module 08 owns none of them (§15).
 *
 * Errors are not caught — the global filter maps them: `NOT_FOUND` (404) for an unknown collection,
 * `CONFLICT` (409) for a step attempted from the wrong stage or a request to restate a recorded
 * fact, and `VALIDATION_ERROR` (400) for a malformed body or a currency that disagrees with the
 * collection.
 */
@Controller('admin/delivery/cod-reconciliation')
export class AdminCodReconciliationController {
  constructor(
    private readonly list: ListCodCollectionsQuery,
    private readonly remit: RecordCodRemittanceCommand,
    private readonly reconcile: ReconcileCodCollectionCommand,
  ) {}

  /**
   * The COD queue (§18, §19).
   *
   * Filter by channel, status, currency, period, handover reference or order. `status=COLLECTED`
   * is "cash the platform has not been handed"; `status=REMITTED` is "handed over, not yet checked";
   * `remittanceReference=...` reconstructs one handover across every collection in it.
   */
  @Get()
  @RequirePermissions('finance:report:any')
  async search(
    @Query() query: ListCodCollectionsQueryDto,
  ): Promise<CodReconciliationPageResponse> {
    return toCodReconciliationPageResponse(
      await this.list.execute({
        driverId: query.driverId,
        status: query.status,
        currency: query.currency,
        remittanceReference: query.remittanceReference,
        orderId: query.orderId,
        from: toDate(query.from),
        to: toDate(query.to),
        page: query.page,
        size: query.size,
      }),
    );
  }

  /**
   * Totals over the same filters as the queue above (§18, §19).
   *
   * **Declared before `:collectionId`, and it has to be.** Nest matches routes in declaration
   * order, so a `@Get('summary')` placed after the parameterised read would never be reached — the
   * request would arrive at `getOne` with a collection id of `"summary"` and answer `NOT_FOUND`.
   * That is the kind of bug that looks like a data problem for an afternoon.
   *
   * It answers what a page cannot: the outstanding total across every page, not the one in view. No
   * settlement is run, nothing is written, and no cadence is implied — the caller chooses the
   * period, and `remittanceReference` is what reconstructs a single handover.
   */
  @Get('summary')
  @RequirePermissions('finance:report:any')
  async summary(
    @Query() query: ListCodCollectionsQueryDto,
  ): Promise<CodCollectionSummaryResponse> {
    return toCodCollectionSummaryResponse(
      await this.list.summarize({
        driverId: query.driverId,
        status: query.status,
        currency: query.currency,
        remittanceReference: query.remittanceReference,
        orderId: query.orderId,
        from: toDate(query.from),
        to: toDate(query.to),
      }),
    );
  }

  /** One collection with its remittance and its reconciliation, whichever channel carried it. */
  @Get(':collectionId')
  @RequirePermissions('finance:report:any')
  async getOne(
    @Param('collectionId') collectionId: string,
  ): Promise<CodReconciliationDetailResponse> {
    return toCodReconciliationDetailResponse(await this.list.byId(collectionId));
  }

  /**
   * Confirms that the channel handed the money to PharmaLink (§1, §3, §4).
   *
   * `200`, not `201`: the response is the collection's state, whether this call recorded the
   * handover or replayed one already recorded. A `201` that a replay could not honestly return
   * would make the status code the one part of the response a client cannot rely on — the same
   * reasoning `POST /admin/finance/settlements/run` gives.
   *
   * The confirming operator comes from the token. There is no field on the DTO through which an
   * actor could arrive, so a request cannot attribute the confirmation to somebody else.
   */
  @Post(':collectionId/remit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance:settlement:any')
  async recordRemittance(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('collectionId') collectionId: string,
    @Body() body: RecordCodRemittanceDto,
  ): Promise<RecordCodRemittanceResponse> {
    return toRecordCodRemittanceResponse(
      await this.remit.execute({
        actorUserId: user.userId,
        collectionId,
        remittedAmount: body.remittedAmount,
        reference: body.reference,
        currency: body.currency ?? null,
        note: body.note ?? null,
        remittedAt: body.remittedAt ? new Date(body.remittedAt) : null,
      }),
    );
  }

  /**
   * Records PharmaLink's finding about a remittance (§5, §6, §7).
   *
   * Only reachable from `REMITTED`. A collection still at `COLLECTED` answers `409` however the
   * caller is authorized, because reconciling money nobody has handed over is the shortcut the
   * three-step lifecycle exists to prevent.
   *
   * The outcome is computed, not supplied — see `ReconcileCodCollectionDto` for why there is no
   * field for it. A discrepancy is recorded and the collection still becomes `RECONCILED`:
   * `RECONCILED` means somebody looked, and `outcome` says what they found.
   */
  @Post(':collectionId/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance:settlement:any')
  async recordReconciliation(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('collectionId') collectionId: string,
    @Body() body: ReconcileCodCollectionDto,
  ): Promise<ReconcileCodCollectionResponse> {
    return toReconcileCodCollectionResponse(
      await this.reconcile.execute({
        actorUserId: user.userId,
        collectionId,
        reference: body.reference ?? null,
        note: body.note ?? null,
      }),
    );
  }
}

/** `@IsDateString` has already rejected anything unparseable, so this cannot yield `Invalid Date`. */
function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
