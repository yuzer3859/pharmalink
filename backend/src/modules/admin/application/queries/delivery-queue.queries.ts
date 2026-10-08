import { Inject, Injectable } from '@nestjs/common';
import {
  DeliveryAttemptView,
  DeliveryJobPage,
  DeliveryJobSearchCriteria,
  DeliveryJobView,
  DeliveryQueueSummary,
  INotificationDeliveryAdminPort,
  NOTIFICATION_DELIVERY_ADMIN_PORT,
} from '../../../notifications/application/ports/inbound/notification-delivery-admin.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_DELIVERY_JOB_PAGE = 1;
export const DEFAULT_DELIVERY_JOB_PAGE_SIZE = 20;
export const MAX_DELIVERY_JOB_PAGE_SIZE = 100;

export interface ListDeliveryJobsInput extends DeliveryJobSearchCriteria {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/notifications/delivery` (module-16 Work 20): Module 13's delivery jobs, newest first,
 * through `NOTIFICATION_DELIVERY_ADMIN_PORT`. Paging clamped to 1..100 (default 20) like every
 * Module 16 list. Read-only; not audited (Module 16 has no sensitive-read convention).
 */
@Injectable()
export class ListDeliveryJobsQuery {
  constructor(@Inject(NOTIFICATION_DELIVERY_ADMIN_PORT) private readonly deliveries: INotificationDeliveryAdminPort) {}

  execute(input: ListDeliveryJobsInput): Promise<DeliveryJobPage> {
    const page = input.page !== undefined && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_DELIVERY_JOB_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_DELIVERY_JOB_PAGE_SIZE)
        : DEFAULT_DELIVERY_JOB_PAGE_SIZE;
    const { page: _p, size: _s, ...criteria } = input; // eslint-disable-line @typescript-eslint/no-unused-vars
    return this.deliveries.listJobs(criteria, page, size);
  }
}

/** `GET /admin/notifications/delivery/:id` — unknown → 404. */
@Injectable()
export class GetDeliveryJobQuery {
  constructor(@Inject(NOTIFICATION_DELIVERY_ADMIN_PORT) private readonly deliveries: INotificationDeliveryAdminPort) {}

  async execute(id: string): Promise<DeliveryJobView> {
    const job = await this.deliveries.getJob(id);
    if (!job) throw AdminErrors.deliveryJobNotFound();
    return job;
  }
}

/** `GET /admin/notifications/delivery/:id/attempts` — the job's history, oldest first; unknown job → 404. */
@Injectable()
export class ListDeliveryAttemptsQuery {
  constructor(@Inject(NOTIFICATION_DELIVERY_ADMIN_PORT) private readonly deliveries: INotificationDeliveryAdminPort) {}

  async execute(id: string): Promise<DeliveryAttemptView[]> {
    const attempts = await this.deliveries.attemptsOfJob(id);
    if (!attempts) throw AdminErrors.deliveryJobNotFound();
    return attempts;
  }
}

/** `GET /admin/notifications/delivery/summary` — exact job counts, aggregated by the database. */
@Injectable()
export class GetDeliveryQueueSummaryQuery {
  constructor(@Inject(NOTIFICATION_DELIVERY_ADMIN_PORT) private readonly deliveries: INotificationDeliveryAdminPort) {}

  execute(): Promise<DeliveryQueueSummary> {
    return this.deliveries.summary();
  }
}
