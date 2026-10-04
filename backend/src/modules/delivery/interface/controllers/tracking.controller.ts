import { Controller, Get, Param } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { GetJobTrackingQuery } from '../../application/queries/get-job-tracking.query';
import { TrackingResponse, toTrackingResponse } from '../dtos/tracking.response';

/**
 * The customer's tracking read (§9.4's "REST fallback for status/last-known location", F-TRK-03,
 * NFR-LOC-04).
 *
 * ## Why an HTTP route exists at all when tracking is a WebSocket feature
 *
 * Because NFR-LOC-04 is about *poor connectivity*, and a customer on a network that cannot hold a
 * WebSocket open is exactly the customer who most needs to know where their medicines are. A
 * socket that will not stay up leaves them with nothing; one GET leaves them with the last-known
 * position and the delivery's status. It is a fallback in the literal sense — a client polls this
 * only when the socket is unavailable, and the design names it.
 *
 * It is **not** a second tracking system, and the thing that makes that true is structural rather
 * than stated: both routes below call `GetJobTrackingQuery`, which is the same call the socket's
 * subscribe handler makes, with the same authorization, the same fallback from hot cache to
 * durable record, and the same view. There is one tracking implementation and two ways to ask it.
 * Nothing here can drift from the socket, because there is nothing here to drift.
 *
 * ## Scope, and why this is the customer's surface
 *
 * `order:read:own`, which `CUSTOMER` has held since Phase 0 — **no new permission**. Watching
 * where your own order is *is* reading your own order, and a `delivery:read:own` key would be a
 * second name for the same authority, granted to the same role, requiring an RBAC migration
 * before anybody could track anything.
 *
 * The `DRIVER` role itself does not carry that key, so these routes are shaped for the customer.
 * They are not *closed* to drivers, though, and the reason is worth being precise about rather
 * than assuming: every account registered on this platform is granted `CUSTOMER` alongside
 * whatever else it holds, so a real driver's token does carry `order:read:own` and does reach the
 * handler. What happens then is the right thing — `GetJobTrackingQuery` authorizes them as the
 * job's **assigned driver**, not as its buyer, and a driver who is neither gets `NOT_FOUND` like
 * anybody else. The permission decides who may ask; the query decides what they are allowed to
 * see, and it is the query that is load-bearing.
 *
 * Ownership is proved, never asserted. The path carries a job or order id and nothing about who
 * is asking; the subject comes from the access token, and Module 06 is asked who owns the order.
 * A customer naming somebody else's delivery gets `NOT_FOUND` — not `FORBIDDEN` — so ids cannot be
 * probed to learn who has ordered medicines and when.
 */
@Controller('tracking')
export class TrackingController {
  constructor(private readonly tracking: GetJobTrackingQuery) {}

  /**
   * §9.4's channel, keyed by order — the identifier a customer actually has.
   *
   * A customer knows their order number, not the delivery job id the platform cut from it. For a
   * split order this answers with the leg currently in motion; a client that wants to follow both
   * reads each job id from `fulfillmentId` and asks for them individually.
   */
  @Get('orders/:orderId')
  @RequirePermissions('order:read:own')
  async byOrder(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('orderId') orderId: string,
  ): Promise<TrackingResponse> {
    const { view } = await this.tracking.byOrderId(orderId, user.userId);
    return toTrackingResponse(view);
  }

  /** The same answer addressed by delivery job, for a client following one leg of a split order. */
  @Get('jobs/:jobId')
  @RequirePermissions('order:read:own')
  async byJob(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
  ): Promise<TrackingResponse> {
    const { view } = await this.tracking.byJobId(jobId, user.userId);
    return toTrackingResponse(view);
  }
}
