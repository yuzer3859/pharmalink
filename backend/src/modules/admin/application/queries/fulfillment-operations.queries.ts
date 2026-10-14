import { Inject, Injectable } from '@nestjs/common';
import {
  FULFILLMENT_OPERATIONS_READ_PORT,
  FulfillmentOperationsFilter,
  FulfillmentOperationsPage,
  FulfillmentOperationsView,
  IFulfillmentOperationsReadPort,
} from '../../../orders/application/ports/inbound/fulfillment-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_FULFILLMENT_OPERATIONS_PAGE = 1;
export const DEFAULT_FULFILLMENT_OPERATIONS_PAGE_SIZE = 20;
export const MAX_FULFILLMENT_OPERATIONS_PAGE_SIZE = 100;

export interface ListFulfillmentOperationsInput extends FulfillmentOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/fulfillments` (module-16 Work 46): Module 06 fulfillments newest first,
 * through `FULFILLMENT_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20), as every Module
 * 16 list. Read-only; not audited; no other module is called.
 */
@Injectable()
export class ListFulfillmentOperationsQuery {
  constructor(@Inject(FULFILLMENT_OPERATIONS_READ_PORT) private readonly fulfillments: IFulfillmentOperationsReadPort) {}

  execute(input: ListFulfillmentOperationsInput): Promise<FulfillmentOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_FULFILLMENT_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_FULFILLMENT_OPERATIONS_PAGE_SIZE)
        : DEFAULT_FULFILLMENT_OPERATIONS_PAGE_SIZE;
    const filter: FulfillmentOperationsFilter = {
      status: input.status,
      orderId: input.orderId,
      pharmacyId: input.pharmacyId,
      branchId: input.branchId,
      hasDeliveryJobReference: input.hasDeliveryJobReference,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      readyFrom: input.readyFrom,
      readyTo: input.readyTo,
    };
    return this.fulfillments.listFulfillments(filter, page, size);
  }
}

/**
 * `GET /admin/operations/fulfillments/:fulfillmentId` (module-16 Work 46): one fulfillment with its
 * order id and recorded delivery-job id, for navigation to the Work 35 order and Work 36 delivery
 * details. Unknown → 404. It never asks Module 08 and never repairs a missing reference.
 */
@Injectable()
export class GetFulfillmentOperationsQuery {
  constructor(@Inject(FULFILLMENT_OPERATIONS_READ_PORT) private readonly fulfillments: IFulfillmentOperationsReadPort) {}

  async execute(fulfillmentId: string): Promise<FulfillmentOperationsView> {
    const fulfillment = await this.fulfillments.getFulfillment(fulfillmentId);
    if (!fulfillment) throw AdminErrors.fulfillmentNotFound();
    return fulfillment;
  }
}
