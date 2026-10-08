import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { RetryDeliveryJobCommand } from '../../application/commands/retry-delivery-job.command';
import { DeliveryJobResponse, toDeliveryJobResponse } from '../dtos/delivery-queue.response';

/**
 * The delivery queue's one mutation (module-16 Work 21), kept out of the read-only
 * `AdminDeliveryQueueController`:
 *
 *     POST /admin/notifications/delivery/:id/retry   EXHAUSTED → PENDING; 200 with the job
 *
 * `notification:queue:manage` — ADMIN only, never implied by `notification:queue:read`. No body:
 * the actor comes from the token. Audited as `ADMIN_NOTIFICATION_DELIVERY_RETRIED`.
 */
@Controller('admin/notifications/delivery')
export class AdminDeliveryRetryController {
  constructor(private readonly retry: RetryDeliveryJobCommand) {}

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('notification:queue:manage')
  async retryOne(
    @CurrentUser() actor: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeliveryJobResponse> {
    return toDeliveryJobResponse(await this.retry.execute({ actorUserId: actor.userId, jobId: id, ip: req.ip ?? null }));
  }
}
