import { Inject, Injectable } from '@nestjs/common';
import {
  DELIVERY_OPERATIONS_READ_PORT,
  DeliveryOperationsDetail,
  DeliveryOperationsFilter,
  DeliveryOperationsPage,
  IDeliveryOperationsReadPort,
} from '../../../delivery/application/ports/inbound/delivery-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_DELIVERY_OPERATIONS_PAGE = 1;
export const DEFAULT_DELIVERY_OPERATIONS_PAGE_SIZE = 20;
export const MAX_DELIVERY_OPERATIONS_PAGE_SIZE = 100;

export interface ListDeliveryOperationsInput extends DeliveryOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/deliveries` (module-16 Work 36): Module 08 delivery jobs newest first,
 * through `DELIVERY_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20), as every Module 16
 * list. The status is Module 08's stored job status, as returned. Read-only; not audited.
 */
@Injectable()
export class ListDeliveryOperationsQuery {
  constructor(@Inject(DELIVERY_OPERATIONS_READ_PORT) private readonly deliveries: IDeliveryOperationsReadPort) {}

  execute(input: ListDeliveryOperationsInput): Promise<DeliveryOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_DELIVERY_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_DELIVERY_OPERATIONS_PAGE_SIZE)
        : DEFAULT_DELIVERY_OPERATIONS_PAGE_SIZE;
    const filter: DeliveryOperationsFilter = {
      status: input.status,
      orderId: input.orderId,
      isCod: input.isCod,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.deliveries.listJobs(filter, page, size);
  }
}

/**
 * `GET /admin/operations/deliveries/:deliveryJobId` (module-16 Work 36): one delivery job, its
 * timeline and its COD collection state, all from Module 08 in one snapshot. Unknown job → 404.
 * Nothing is read from Module 06 or 07. Read-only; not audited.
 */
@Injectable()
export class GetDeliveryOperationsQuery {
  constructor(@Inject(DELIVERY_OPERATIONS_READ_PORT) private readonly deliveries: IDeliveryOperationsReadPort) {}

  async execute(deliveryJobId: string): Promise<DeliveryOperationsDetail> {
    const job = await this.deliveries.getJob(deliveryJobId);
    if (!job) throw AdminErrors.deliveryOperationsJobNotFound();
    return job;
  }
}
