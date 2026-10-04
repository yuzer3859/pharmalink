import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ManageCodDisputeCommand } from '../../application/commands/manage-cod-dispute.command';
import { RecordCodCorrectionCommand } from '../../application/commands/record-cod-correction.command';
import { ListCodCollectionsQuery } from '../../application/queries/list-cod-collections.query';
import {
  OpenCodDisputeDto,
  RecordCodCorrectionDto,
  ResolveCodDisputeDto,
} from '../dtos/cod-correction.dto';
import {
  CodCorrectionResponse,
  CodDisputeMutationResponse,
  CodDisputeResponse,
  RecordCodCorrectionResponse,
  toCodCollectionLifecycleResponse,
  toCodCorrectionResponse,
  toCodDisputeResponse,
} from '../dtos/cod-remittance.response';

/**
 * Corrections and disputes against COD records (§3.5 F-COD-01, the design's Open Question 5).
 *
 *     POST /admin/delivery/cod-reconciliation/{id}/corrections            record a correction
 *     GET  /admin/delivery/cod-reconciliation/{id}/corrections            the correction trail
 *     POST /admin/delivery/cod-reconciliation/{id}/disputes               raise a question
 *     GET  /admin/delivery/cod-reconciliation/{id}/disputes               the dispute trail
 *     POST /admin/delivery/cod-reconciliation/{id}/disputes/{did}/resolve close it
 *
 * ## Why these are separate from the lifecycle controller
 *
 * `AdminCodReconciliationController` moves a collection through
 * `COLLECTED → REMITTED → RECONCILED`. Nothing here moves anything: a correction and a dispute are
 * records placed *beside* that history, and keeping them in their own file is the same separation
 * the tables themselves have. They share the prefix because they are the same resource family and
 * the same finance surface — a reader looking for "everything PharmaLink can do about COD cash"
 * finds one URL space and two focused files.
 *
 * ## Authorization, and the separation of duties
 *
 * | Route | Permission | Held by |
 * | --- | --- | --- |
 * | the two reads | `finance:report:any` | `FINANCE_OFFICER`, `ADMIN` |
 * | correct, open, resolve | `finance:settlement:any` | `FINANCE_OFFICER` |
 *
 * Both are existing catalogue keys — **no permission was invented, and none was regranted.** The
 * existing meaning of `finance:settlement:any` is cash-handling authority, which is exactly what
 * restating a COD figure and closing a question about one are; §3's preference for the existing key
 * is satisfied without stretching it.
 *
 * **No driver role holds either key**, so §3's "a driver must never create or approve a correction
 * affecting their own collection" and §12's "must not resolve their own dispute" are properties of
 * the RBAC catalogue rather than checks somebody remembered to write. There is additionally no
 * route on the driver surface that reaches any of this: a driver's `GET /delivery/jobs/{id}/
 * cod-collection` reports `hasOpenDispute` as a bare boolean and nothing else.
 *
 * Per-route decorators rather than class-level, matching the lifecycle controller and for the same
 * reason: read authority and write authority differ here, and `PermissionsGuard` requires **every**
 * listed permission, so a class-level settlement key would lock administrators out of a read the
 * design gives them.
 *
 * ## What is deliberately absent
 *
 * **No `PATCH`, `PUT` or `DELETE`, on anything** (§14). Nothing here can edit a collected amount, a
 * remitted amount, a method, a reference, a timestamp or a recorded finding; nothing can edit a
 * correction after it is filed, and nothing can delete a dispute. A mistaken correction is answered
 * by another correction, which is why corrections are a list rather than a slot.
 *
 * No route writes a ledger entry, a payable, a settlement or a payout, and none can write money off
 * or recover it from a driver — there is no correction type, no dispute outcome and no request field
 * through which any of that could be expressed (§7).
 *
 * Errors are not caught — the global filter maps them: `NOT_FOUND` (404) for an unknown collection
 * or dispute, `CONFLICT` (409) for a correction naming another collection's record or a second,
 * different resolution, `IDEMPOTENCY_CONFLICT` (409) for a replay key reused for a different
 * correction, and `VALIDATION_ERROR` (400) for a value pair that does not match its correction type.
 */
@Controller('admin/delivery/cod-reconciliation')
export class AdminCodCorrectionController {
  constructor(
    private readonly correct: RecordCodCorrectionCommand,
    private readonly disputes: ManageCodDisputeCommand,
    private readonly read: ListCodCollectionsQuery,
  ) {}

  /**
   * Records what a COD record should have said.
   *
   * `200`, not `201`: the response is the correction, whether this call filed it or replayed one
   * already filed under the same key. A `201` a replay could not honestly return would make the
   * status code the one part of the response a client cannot rely on — the same reasoning the
   * remit and reconcile routes give.
   *
   * The response carries the collection **unchanged** beside the correction. That is the shape the
   * whole work is about: the original figures are still the original figures, and the correction
   * sits next to them rather than replacing them (§6).
   */
  @Post(':collectionId/corrections')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance:settlement:any')
  async record(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('collectionId') collectionId: string,
    @Body() body: RecordCodCorrectionDto,
  ): Promise<RecordCodCorrectionResponse> {
    const result = await this.correct.execute({
      // From the token. There is no DTO field through which an actor could arrive.
      actorUserId: user.userId,
      collectionId,
      type: body.type,
      remittanceId: body.remittanceId ?? null,
      reconciliationId: body.reconciliationId ?? null,
      originalAmount: body.originalAmount ?? null,
      correctedAmount: body.correctedAmount ?? null,
      originalReference: body.originalReference ?? null,
      correctedReference: body.correctedReference ?? null,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    });

    return {
      created: result.created,
      collection: toCodCollectionLifecycleResponse(await this.read.byId(collectionId)),
      correction: toCodCorrectionResponse(result.correction),
    };
  }

  /** The correction trail for one collection, oldest first. */
  @Get(':collectionId/corrections')
  @RequirePermissions('finance:report:any')
  async listCorrections(
    @Param('collectionId') collectionId: string,
  ): Promise<CodCorrectionResponse[]> {
    const view = await this.read.byId(collectionId);
    return view.corrections.map(toCodCorrectionResponse);
  }

  /**
   * Raises a question about a collection.
   *
   * A collection may be disputed at **any** stage — a shortfall is often noticed at the cash desk
   * before anybody has reconciled anything, and requiring `RECONCILED` first would leave the most
   * urgent case with nowhere to be recorded.
   *
   * A second open dispute is not created: the existing one comes back with `created: false`, so two
   * operators noticing the same problem converge on one investigation rather than splitting it.
   */
  @Post(':collectionId/disputes')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance:settlement:any')
  async openDispute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('collectionId') collectionId: string,
    @Body() body: OpenCodDisputeDto,
  ): Promise<CodDisputeMutationResponse> {
    const result = await this.disputes.open({
      actorUserId: user.userId,
      collectionId,
      reason: body.reason,
    });

    return {
      created: result.created,
      collection: toCodCollectionLifecycleResponse(await this.read.byId(collectionId)),
      dispute: toCodDisputeResponse(result.dispute),
    };
  }

  /** The dispute trail for one collection, newest first. */
  @Get(':collectionId/disputes')
  @RequirePermissions('finance:report:any')
  async listDisputes(@Param('collectionId') collectionId: string): Promise<CodDisputeResponse[]> {
    const view = await this.read.byId(collectionId);
    return view.disputes.map(toCodDisputeResponse);
  }

  /**
   * Closes a dispute, naming who closed it and what they concluded.
   *
   * The resolution is free text — see `ResolveCodDisputeDto` for why there is no outcome field.
   * Resolving changes nothing about the money: no amount, no status on the collection, no ledger
   * entry, and the discrepancy that prompted the dispute stays exactly as visible as it was.
   */
  @Post(':collectionId/disputes/:disputeId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('finance:settlement:any')
  async resolveDispute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('collectionId') collectionId: string,
    @Param('disputeId') disputeId: string,
    @Body() body: ResolveCodDisputeDto,
  ): Promise<CodDisputeMutationResponse> {
    const result = await this.disputes.resolve({
      actorUserId: user.userId,
      collectionId,
      disputeId,
      resolutionNote: body.resolutionNote ?? null,
    });

    return {
      created: result.created,
      collection: toCodCollectionLifecycleResponse(await this.read.byId(collectionId)),
      dispute: toCodDisputeResponse(result.dispute),
    };
  }
}
