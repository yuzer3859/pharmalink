import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import {
  GetDeliveryJobQuery,
  GetDeliveryQueueSummaryQuery,
  ListDeliveryAttemptsQuery,
  ListDeliveryJobsQuery,
} from '../../application/queries/delivery-queue.queries';
import { GetDeliveryQueueHealthQuery } from '../../application/queries/delivery-queue-health.query';
import { ListDeliveryJobsQueryDto } from '../dtos/delivery-queue.dto';
import {
  DeliveryAttemptResponse,
  DeliveryJobListResponse,
  DeliveryJobResponse,
  DeliveryQueueSummaryResponse,
  toDeliveryAttemptResponse,
  toDeliveryJobListResponse,
  toDeliveryJobResponse,
  toDeliveryQueueSummaryResponse,
} from '../dtos/delivery-queue.response';
import { DeliveryQueueHealthResponse, toDeliveryQueueHealthResponse } from '../dtos/delivery-queue-health.response';

/**
 * Read-only visibility into Module 13's notification delivery queue (module-16 Work 20), over
 * `NOTIFICATION_DELIVERY_ADMIN_PORT`.
 *
 *     GET /admin/notifications/delivery                ?channel &status &notificationId &createdFrom
 *                                                      &createdTo &nextAttemptFrom &nextAttemptTo &page &size
 *     GET /admin/notifications/delivery/summary        exact job counts, total / by status / by channel
 *     GET /admin/notifications/delivery/health         backlog and stale-lease aggregates (Work 22)
 *     GET /admin/notifications/delivery/:id            one job
 *     GET /admin/notifications/delivery/:id/attempts   its history, oldest first
 *
 * All take `notification:queue:read` — ADMIN only, named after `verification:queue:read`. There
 * is no mutation route here (Work 21's retry has its own controller and permission). Not audited.
 */
@Controller('admin/notifications/delivery')
@RequirePermissions('notification:queue:read')
export class AdminDeliveryQueueController {
  constructor(
    private readonly list: ListDeliveryJobsQuery,
    private readonly getOne: GetDeliveryJobQuery,
    private readonly attempts: ListDeliveryAttemptsQuery,
    private readonly summaryQuery: GetDeliveryQueueSummaryQuery,
    private readonly healthQuery: GetDeliveryQueueHealthQuery,
  ) {}

  @Get()
  async search(@Query() q: ListDeliveryJobsQueryDto): Promise<DeliveryJobListResponse> {
    const date = (v?: string) => (v ? new Date(v) : undefined);
    return toDeliveryJobListResponse(
      await this.list.execute({
        channel: q.channel as never,
        status: q.status,
        notificationId: q.notificationId,
        createdFrom: date(q.createdFrom),
        createdTo: date(q.createdTo),
        nextAttemptFrom: date(q.nextAttemptFrom),
        nextAttemptTo: date(q.nextAttemptTo),
        page: q.page,
        size: q.size,
      }),
    );
  }

  // Declared before `:id` so `summary` is never taken for an id (and `:id` is a UUID anyway).
  @Get('summary')
  async summary(): Promise<DeliveryQueueSummaryResponse> {
    return toDeliveryQueueSummaryResponse(await this.summaryQuery.execute());
  }

  // Also before `:id`. Work 22.
  @Get('health')
  async health(): Promise<DeliveryQueueHealthResponse> {
    return toDeliveryQueueHealthResponse(await this.healthQuery.execute());
  }

  @Get(':id')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<DeliveryJobResponse> {
    return toDeliveryJobResponse(await this.getOne.execute(id));
  }

  @Get(':id/attempts')
  async history(@Param('id', new ParseUUIDPipe()) id: string): Promise<{ items: DeliveryAttemptResponse[] }> {
    return { items: (await this.attempts.execute(id)).map(toDeliveryAttemptResponse) };
  }
}
