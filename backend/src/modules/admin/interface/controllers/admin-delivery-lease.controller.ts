import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { ReleaseDeliveryLeaseCommand } from '../../application/commands/release-delivery-lease.command';
import { DeliveryJobResponse, toDeliveryJobResponse } from '../dtos/delivery-queue.response';

/**
 * Lease recovery for the delivery queue (module-16 Work 23), kept out of the read-only
 * `AdminDeliveryQueueController`:
 *
 *     POST /admin/notifications/delivery/:id/release   PROCESSING (lease lapsed) → PENDING; 200 with the job
 *
 * `notification:queue:manage` — the Work 21 key; ADMIN only, never implied by
 * `notification:queue:read`. No body: the actor comes from the token. Audited as
 * `ADMIN_NOTIFICATION_DELIVERY_LEASE_RELEASED`. The response is the Work 20 job shape.
 */
@Controller('admin/notifications/delivery')
export class AdminDeliveryLeaseController {
  constructor(private readonly release: ReleaseDeliveryLeaseCommand) {}

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notification:queue:manage')
  async releaseOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeliveryJobResponse> {
    return toDeliveryJobResponse(await this.release.execute({ actorUserId: actor.userId, jobId: id, ip: req.ip ?? null }));
  }
}
