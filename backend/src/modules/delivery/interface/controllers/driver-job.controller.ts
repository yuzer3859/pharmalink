import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AcceptJobOfferCommand } from '../../application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../application/commands/advance-delivery-job.command';
import { DeclineJobOfferCommand } from '../../application/commands/decline-job-offer.command';
import { GetDeliveryJobStatusQuery } from '../../application/queries/get-delivery-job-status.query';
import { DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import {
  DeclineJobOfferDto,
  DeliveryStatusUpdateDto,
  FailDeliveryJobDto,
} from '../dtos/job-offer.dto';
import {
  AcceptJobOfferResponse,
  DeclineJobOfferResponse,
  DeliveryJobStatusResponse,
  DeliveryStatusResponse,
  toAcceptJobOfferResponse,
  toDeclineJobOfferResponse,
  toDeliveryJobStatusResponse,
  toDeliveryStatusResponse,
} from '../dtos/job-offer.response';

/**
 * A driver's own delivery job: answering an offer, and posting progress (§9.2).
 *
 * ## Why Module 08 gets controllers at all, having deliberately had none for three works
 *
 * The job-creation and driver-profile works both declined to add routes, on the grounds that a
 * route without a permission that describes it means inventing an RBAC grant ahead of the surface
 * it guards. That objection does not apply here, and the difference is concrete: the RBAC
 * catalogue has carried `delivery:accept:own` and `delivery:update:own` since Phase 0, both
 * granted to `DRIVER` and both attached to nothing. They were seeded for exactly these routes,
 * which §9.2 names.
 *
 * So no permission is invented. `delivery:accept:own` guards accept; `delivery:update:own` guards
 * decline — a decline is the driver updating their own offer, not accepting anything, and giving
 * both routes the accept permission would let a token scoped to declining take a job.
 *
 * The status-workflow routes take `delivery:update:own` for the same reason: posting progress on
 * a job you are already carrying *is* updating your own delivery, and it is precisely what that
 * permission describes. No new key is needed and none is added.
 *
 * ## Six explicit endpoints, one command
 *
 * §9.2 names each transition as its own route, and that is kept: `/arrived-pickup`, `/picked-up`,
 * `/en-route`, `/arrived-dropoff`, `/deliver`, `/fail`. Those are the business operations a driver
 * performs, and a single `PATCH {status}` would hand the state machine to the client — one typo
 * away from asking for `COMPLETED`. Behind them is one command, because ownership, idempotency,
 * legality and the compare-and-set are identical for all six; the target status comes from the
 * route and never from the body.
 *
 * There is deliberately **no `/complete` route**. `COMPLETED` is the platform closing the job
 * after its settlement-side effects — earnings accrual and COD reconciliation, both later works —
 * not something a driver asserts; the domain-foundation work kept `DELIVERED` and `COMPLETED`
 * apart for exactly that reason, and a driver-triggered completion would make the distinction
 * decorative. The command exists and is callable in-process.
 *
 * **Dispatch and reassignment have no routes either.** Dispatch is event-driven (§11.1's
 * `JobCreated → DispatchJob`), so §9.3's internal endpoint would be a second way to do what the
 * handler already does. §9.5's admin reassign route would need a platform-scoped delivery
 * permission the catalogue does not have — there is no `delivery:*:any` key and no admin delivery
 * grant anywhere — so the route waits for the work that adds one deliberately.
 *
 * ## Scope
 *
 * `own` is enforced below this boundary and from the access token alone. No route accepts a driver
 * id, an offer id or a target status: the path names a *job*, and which offer or which driver that
 * means is resolved from the authenticated user. A driver naming a job that is not theirs gets
 * `NOT_FOUND` — not `FORBIDDEN` — so job ids cannot be probed to learn who is carrying what.
 *
 * Errors are not caught. Every failure is already an `ApiException` and the global
 * `AllExceptionsFilter` maps it: `OFFER_EXPIRED` (409), `CONCURRENT_LIMIT_REACHED` (409),
 * `JOB_ALREADY_ASSIGNED` (409), `INVALID_DELIVERY_STATE_TRANSITION` (409),
 * `DRIVER_NOT_VERIFIED` (403), `NOT_FOUND` (404).
 */
@Controller('delivery/jobs')
export class DriverJobController {
  constructor(
    private readonly acceptOffer: AcceptJobOfferCommand,
    private readonly declineOffer: DeclineJobOfferCommand,
    private readonly advance: AdvanceDeliveryJobCommand,
    private readonly jobStatus: GetDeliveryJobStatusQuery,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
  ) {}

  /** §11.2. Assigns the job to the caller, or explains which check refused. */
  @Post(':id/accept')
  @RequirePermissions('delivery:accept:own')
  async accept(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
  ): Promise<AcceptJobOfferResponse> {
    return toAcceptJobOfferResponse(
      await this.acceptOffer.execute({ userId: user.userId, jobId }),
    );
  }

  /** §6.4. Records the refusal and lets dispatch move to the next candidate. */
  @Post(':id/decline')
  @RequirePermissions('delivery:update:own')
  async decline(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: DeclineJobOfferDto,
  ): Promise<DeclineJobOfferResponse> {
    return toDeclineJobOfferResponse(
      await this.declineOffer.execute({
        userId: user.userId,
        jobId,
        reason: body.reason ?? null,
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // The status workflow (§3.3 F-STS-01, §9.2, §11.4).
  //
  // Every route is idempotent: repeating the status the job already holds returns the current
  // state with `changed: false` and writes nothing — no history row, no audit entry, no event.
  // That is what makes a handset's retry-on-timeout safe (§12, NFR-LOC-04), and it is why none of
  // these is a self-loop in the state machine.
  // -------------------------------------------------------------------------------------------

  /** The driver has reached the pharmacy. */
  @Post(':id/arrived-pickup')
  @RequirePermissions('delivery:update:own')
  async arrivedPickup(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: DeliveryStatusUpdateDto,
  ): Promise<DeliveryStatusResponse> {
    return this.advanceTo(user, jobId, DeliveryJobStatus.ARRIVED_PICKUP, body);
  }

  /**
   * The driver has the medicines.
   *
   * The boundary this module's rules turn on: past here the job cannot be cancelled and cannot be
   * reassigned, and `OrderPickedUp` has told Module 06 that goods are in transit.
   */
  @Post(':id/picked-up')
  @RequirePermissions('delivery:update:own')
  async pickedUp(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: DeliveryStatusUpdateDto,
  ): Promise<DeliveryStatusResponse> {
    return this.advanceTo(user, jobId, DeliveryJobStatus.PICKED_UP, body);
  }

  /** On the way to the customer. */
  @Post(':id/en-route')
  @RequirePermissions('delivery:update:own')
  async enRoute(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: DeliveryStatusUpdateDto,
  ): Promise<DeliveryStatusResponse> {
    return this.advanceTo(user, jobId, DeliveryJobStatus.EN_ROUTE, body);
  }

  /** At the customer's door. */
  @Post(':id/arrived-dropoff')
  @RequirePermissions('delivery:update:own')
  async arrivedDropoff(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: DeliveryStatusUpdateDto,
  ): Promise<DeliveryStatusResponse> {
    return this.advanceTo(user, jobId, DeliveryJobStatus.ARRIVED_DROPOFF, body);
  }

  /**
   * Handed over.
   *
   * §9.2 sketches this route as taking `{ podType, artifactRef?, recipientName?, codCollected? }`,
   * and it still takes none of them. Proof of delivery now exists, but it is captured through
   * `POST /delivery/jobs/{id}/proof-of-delivery` and read from the database here — the driver's
   * evidence is not something the delivery post asserts. Letting a client pass `artifactRef` would
   * be letting it name the evidence for its own delivery, which is the one thing a proof system
   * must not accept; `forbidNonWhitelisted` turns sending it into a `400`.
   *
   * What this route now does that it did not before: immediately before the transition,
   * `AdvanceDeliveryJobCommand` resolves the configured requirement (BRULE-29) and refuses with
   * `POD_REQUIRED` (409) when the delivery needs proof it does not have. Nothing is written when
   * it refuses — no status change, no history row, no event.
   *
   * `codCollected` remains unaccepted: COD reconciliation is a later work and has no store to
   * record it in.
   */
  @Post(':id/deliver')
  @RequirePermissions('delivery:update:own')
  async deliver(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: DeliveryStatusUpdateDto,
  ): Promise<DeliveryStatusResponse> {
    return this.advanceTo(user, jobId, DeliveryJobStatus.DELIVERED, body);
  }

  /**
   * The delivery could not be completed (§3.3 F-STS-05 — recipient absent, address wrong).
   *
   * The reason is required and travels on the `DeliveryFailed` event. What happens next — retry,
   * return to pharmacy, refund — is Module 06's and Module 07's; this route records the fact and
   * emits the hook, and decides nothing about the goods or the money.
   */
  @Post(':id/fail')
  @RequirePermissions('delivery:update:own')
  async fail(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: FailDeliveryJobDto,
  ): Promise<DeliveryStatusResponse> {
    return this.advanceTo(user, jobId, DeliveryJobStatus.FAILED, body, body.reason);
  }

  /**
   * §9.4's REST fallback: the job's status and its transition trail.
   *
   * Scoped to the job's current driver, resolved from the token; another driver's job answers
   * `NOT_FOUND`. The customer-facing variant of this read needs *order* ownership rather than
   * driver ownership, and belongs with the tracking work that also owns the live position.
   */
  @Get(':id/status')
  @RequirePermissions('delivery:update:own')
  async status(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
  ): Promise<DeliveryJobStatusResponse> {
    const profile = await this.profiles.findByUserId(user.userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId: user.userId });
    }
    return toDeliveryJobStatusResponse(
      await this.jobStatus.execute({ jobId, requireDriverId: profile.id }),
    );
  }

  private async advanceTo(
    user: AuthenticatedPrincipal,
    jobId: string,
    to: DeliveryJobStatus,
    body: DeliveryStatusUpdateDto,
    reason?: string,
  ): Promise<DeliveryStatusResponse> {
    return toDeliveryStatusResponse(
      await this.advance.byDriver({
        userId: user.userId,
        jobId,
        to,
        reason: reason ?? null,
        lat: body.lat ?? null,
        lng: body.lng ?? null,
      }),
    );
  }
}
