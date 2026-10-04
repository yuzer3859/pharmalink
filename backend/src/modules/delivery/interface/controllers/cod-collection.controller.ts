import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RecordCodCollectionCommand } from '../../application/commands/record-cod-collection.command';
import { GetCodCollectionQuery } from '../../application/queries/get-cod-collection.query';
import { RecordCodCollectionDto } from '../dtos/cod-collection.dto';
import {
  CodCollectionResponse,
  RecordCodCollectionResponse,
  toCodCollectionResponse,
  toRecordCodCollectionResponse,
} from '../dtos/cod-collection.response';

/**
 * Cash on delivery: recording what the driver collected, and reading it back (§3.5 F-COD-01, §17).
 *
 * ## Two routes, and a deliberate absence
 *
 * `POST` records a collection; `GET` reads one. **There is no route that marks a collection
 * remitted, reconciled or settled**, and that absence is the substantive design decision on this
 * controller rather than an omission to be filled in later.
 *
 * The only actor with a route anywhere near this aggregate is the **driver who is holding the
 * cash**. A `PATCH .../reconcile` here — whatever permission guarded it — would sit one refactor
 * away from a collection channel certifying its own remittance, which is the single thing a COD
 * process exists to prevent. Remittance and reconciliation arrive with the work that defines the
 * cadence (the design's Open Question 5) *and* the authority that may perform them, together.
 *
 * Nor is there any route that changes an amount. The expected figure comes from the job and is not
 * an input anywhere; the collected figure is immutable once recorded, enforced at three layers —
 * the aggregate has no mutator, the repository has no `update`, and there is no verb here that
 * could reach either.
 *
 * ## Route naming
 *
 * The brief suggests `POST /driver/jobs/{id}/cod-collection`; this module has never used a
 * `/driver` prefix for a route whose resource is a **job**, exactly as the proof-of-delivery work
 * set out — `delivery/jobs/{id}/...` is the established shape, and who may act on it is a matter
 * for the permission rather than the URL. (`GET /driver/earnings` keeps its prefix because there
 * the resource genuinely is the driver's own ledger, not a job.)
 *
 * ## Authorization
 *
 * `delivery:update:own` to record — taking a customer's money on a job you are carrying *is*
 * updating your own delivery, and it is the same key `/deliver` and every other driver post uses.
 * `delivery:read:own` to read, the key the earnings work added for exactly this shape of question.
 * No new RBAC key here.
 *
 * The permission decides who may ask; the command and the query decide what they may touch, and
 * they are what is load-bearing. Both resolve `driver_profiles.id` from the access token and
 * require the job to name it. A driver who is not carrying the delivery gets `NOT_FOUND`, never
 * `FORBIDDEN`, so job ids cannot be probed for who collected cash on them.
 *
 * ## This route does not deliver anything
 *
 * Recording a collection changes no delivery status, emits no delivery-status event and completes
 * nothing. The job stays at `ARRIVED_DROPOFF` until the driver posts `/deliver`, which is where the
 * proof requirement is checked — so the expected sequence falls out on its own:
 * `ARRIVED_DROPOFF → record COD → capture PoD → DELIVERED`. Keeping the three apart is what lets a
 * handset retry any one of them on a bad connection without re-attempting the others.
 *
 * Errors are not caught — the global filter maps them: `NOT_FOUND` (404) for a job that is not the
 * caller's or a collection that does not exist, `CONFLICT` (409) for a collection attempted outside
 * `ARRIVED_DROPOFF`, on a non-COD delivery, or restating an existing record,
 * `BUSINESS_RULE_VIOLATION` (422) for an amount an operator's exact-payment rule refuses, and
 * `VALIDATION_ERROR` (400) for a malformed body or a reference on a cash collection.
 */
@Controller('delivery/jobs')
export class CodCollectionController {
  constructor(
    private readonly record: RecordCodCollectionCommand,
    private readonly read: GetCodCollectionQuery,
  ) {}

  /**
   * Records what the customer handed over (§3.5 F-COD-01).
   *
   * Idempotent by the database rather than by a cache: `cod_collections.jobId` is unique, so a
   * handset retrying the same declaration gets the stored record back with `created: false` — no
   * second row, no second audit entry and, most importantly, no second `CodCollected` event telling
   * Module 07 it is owed the same cash twice. A submission carrying a *different* amount, method or
   * reference is refused: restating how much money changed hands is a correction, and a correction
   * is a new auditable adjustment rather than an overwrite of the original declaration.
   */
  @Post(':id/cod-collection')
  @RequirePermissions('delivery:update:own')
  async submit(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: RecordCodCollectionDto,
  ): Promise<RecordCodCollectionResponse> {
    return toRecordCodCollectionResponse(
      await this.record.execute({
        // From the token. There is no field on the DTO through which a driver id could arrive.
        userId: user.userId,
        jobId,
        collectedAmount: body.collectedAmount,
        method: body.method,
        providerReference: body.providerReference ?? null,
        collectedAt: body.collectedAt ? new Date(body.collectedAt) : null,
      }),
    );
  }

  /**
   * What was recorded for this delivery.
   *
   * Both amounts and the signed variance, so a driver can see that a shortfall was recorded as a
   * shortfall. No provider payload and nothing about the customer — see `CodCollectionResponse`.
   */
  @Get(':id/cod-collection')
  @RequirePermissions('delivery:read:own')
  async get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
  ): Promise<CodCollectionResponse> {
    return toCodCollectionResponse(await this.read.byJobId(jobId, user.userId));
  }
}
