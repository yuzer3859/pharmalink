import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { CaptureProofOfDeliveryCommand } from '../../application/commands/capture-proof-of-delivery.command';
import { GetProofOfDeliveryQuery } from '../../application/queries/get-proof-of-delivery.query';
import { CaptureProofOfDeliveryDto } from '../dtos/proof-of-delivery.dto';
import {
  CaptureProofOfDeliveryResponse,
  ProofOfDeliveryResponse,
  toCaptureProofOfDeliveryResponse,
  toProofOfDeliveryResponse,
} from '../dtos/proof-of-delivery.response';

/**
 * Proof of delivery: capturing it, and reading it back (§9.2, §15 of the PoD brief, F-STS-04).
 *
 * ## Two routes on one path, guarded by two different permissions
 *
 * The brief suggests `POST /driver/jobs/{id}/proof-of-delivery`; this module has never used a
 * `/driver` prefix — every driver route since the dispatch work has been `delivery/jobs/{id}/...`,
 * because the resource is the delivery job and who may act on it is a matter for the permission
 * rather than the URL. The brief allows for exactly that ("use the repository's actual established
 * route naming conventions if different"), so both routes sit under the established prefix.
 *
 *  - **`POST`** takes `delivery:update:own`, the same key as `/deliver` and every other progress
 *    post. Capturing evidence on a job you are carrying *is* updating your own delivery, and no
 *    new RBAC key is added — as with all three preceding works in this module.
 *  - **`GET`** takes `order:read:own`, which is what the tracking read uses and what makes this a
 *    surface the *customer* can reach. Reading the evidence for your own order is reading your own
 *    order.
 *
 * The `GET` is not closed to drivers, and that is intentional rather than incidental: every
 * account on this platform holds `CUSTOMER` alongside whatever else it has, so a driver's token
 * carries `order:read:own` and reaches the handler. What happens next is right —
 * `DeliveryAccessService` authorizes them as the job's **assigned driver** rather than as its
 * buyer, and a driver who is neither gets `NOT_FOUND`. The permission decides who may ask; the
 * query decides what they may see, and it is the query that is load-bearing.
 *
 * Making the `GET` require both keys would have been the tempting alternative and it would be
 * wrong twice over: `PermissionsGuard` requires *all* listed permissions, so a customer — who has
 * no `delivery:*` key at all — could never read the evidence for their own delivery.
 *
 * ## There is no second "mark delivered" here
 *
 * §15 is explicit about that, and it is worth stating what this controller does *not* do: posting
 * proof does not deliver anything. It records evidence, and the job stays in `ARRIVED_DROPOFF`
 * until the driver posts `/deliver`, which is where `AdvanceDeliveryJobCommand` checks the
 * requirement and emits `OrderDelivered` exactly as it did before this work existed. Two steps
 * rather than one is deliberate: a handset that uploads a photograph on a bad connection can retry
 * the upload without repeatedly attempting a state transition, and a driver whose evidence was
 * accepted but whose delivery post timed out is in a recoverable position rather than an ambiguous
 * one.
 *
 * ## Scope
 *
 * `own` is enforced below this boundary and from the access token alone. No route accepts a driver
 * id; the path names a job, and which driver that means is resolved from the authenticated user.
 *
 * Errors are not caught — every failure is already an `ApiException` and the global filter maps
 * it: `NOT_FOUND` (404) for a job that is not the caller's or has no proof, `CONFLICT` (409) both
 * for a capture attempted outside `ARRIVED_DROPOFF` and for evidence that would replace evidence,
 * and `VALIDATION_ERROR` (400) for an unsupported media type or an oversized artifact. No new
 * error code was added for either conflict: the catalogue is append-only and 409 already says
 * exactly what is true — the request is well-formed and it is the delivery's current state, or its
 * existing evidence, that refuses it.
 */
@Controller('delivery/jobs')
export class ProofOfDeliveryController {
  constructor(
    private readonly capture: CaptureProofOfDeliveryCommand,
    private readonly read: GetProofOfDeliveryQuery,
  ) {}

  /**
   * Records the evidence of a handover (§3.3 F-STS-04, BRULE-29).
   *
   * Idempotent by the database rather than by a cache: `proof_of_delivery.jobId` is unique, so a
   * handset retrying the same submission gets the stored proof back with `created: false` and no
   * second row, no second artifact and no second audit entry. A submission carrying *different*
   * evidence is refused, because evidence once accepted is not replaceable (§7).
   */
  @Post(':id/proof-of-delivery')
  @RequirePermissions('delivery:update:own')
  async submit(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
    @Body() body: CaptureProofOfDeliveryDto,
  ): Promise<CaptureProofOfDeliveryResponse> {
    return toCaptureProofOfDeliveryResponse(
      await this.capture.execute({
        // From the token. There is no field on the DTO through which a driver id could arrive.
        userId: user.userId,
        jobId,
        type: body.type,
        recipientName: body.recipientName ?? null,
        recipientConfirmed: body.recipientConfirmed,
        artifact: body.artifact
          ? {
              contentType: body.artifact.contentType,
              contentBase64: body.artifact.contentBase64,
            }
          : null,
      }),
    );
  }

  /**
   * §12's authorized read: what evidence exists for this delivery.
   *
   * Metadata only — content type, size, digest, and whether storage still holds it. No storage
   * handle and no download URL; see `ProofOfDeliveryResponse` for why each is absent.
   */
  @Get(':id/proof-of-delivery')
  @RequirePermissions('order:read:own')
  async get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') jobId: string,
  ): Promise<ProofOfDeliveryResponse> {
    const { view } = await this.read.byJobId(jobId, user.userId);
    return toProofOfDeliveryResponse(view);
  }
}
