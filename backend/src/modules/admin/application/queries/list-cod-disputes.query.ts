import { Inject, Injectable } from '@nestjs/common';
import {
  COD_DISPUTE_ADMIN_PORT,
  CodDisputePage,
  CodDisputeSearchCriteria,
  CodDisputeStatus,
  ICodDisputeAdminPort,
} from '../../../delivery/application/ports/inbound/cod-dispute-admin.port';

export const DEFAULT_COD_DISPUTE_PAGE = 1;
export const DEFAULT_COD_DISPUTE_PAGE_SIZE = 20;
export const MAX_COD_DISPUTE_PAGE_SIZE = 100;

export interface ListCodDisputesInput {
  status?: CodDisputeStatus;
  collectionId?: string;
  driverId?: string;
  jobId?: string;
  orderId?: string;
  openedFrom?: Date;
  openedTo?: Date;
  resolvedFrom?: Date;
  resolvedTo?: Date;
  page?: number;
  size?: number;
}

/**
 * `GET /admin/cod-disputes` (module-16 §9.6, F-AD-20) — every COD dispute Module 08 holds,
 * across every collection, newest first.
 *
 * Nothing here is Module 16's data. The rows come through `ICodDisputeAdminPort` with the
 * collection each one questions, and this query adds nothing to them. No status is assumed by
 * default: an administrator's queue is the open ones, but the trail of resolved ones is the
 * history, and both are one filter away.
 */
@Injectable()
export class ListCodDisputesQuery {
  constructor(@Inject(COD_DISPUTE_ADMIN_PORT) private readonly disputes: ICodDisputeAdminPort) {}

  execute(input: ListCodDisputesInput): Promise<CodDisputePage> {
    const page =
      input.page !== undefined && Number.isFinite(input.page) && input.page > 0
        ? Math.floor(input.page)
        : DEFAULT_COD_DISPUTE_PAGE;
    const size =
      input.size !== undefined && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_COD_DISPUTE_PAGE_SIZE)
        : DEFAULT_COD_DISPUTE_PAGE_SIZE;

    const criteria: CodDisputeSearchCriteria = {
      status: input.status,
      collectionId: input.collectionId,
      driverId: input.driverId,
      jobId: input.jobId,
      orderId: input.orderId,
      openedFrom: input.openedFrom,
      openedTo: input.openedTo,
      resolvedFrom: input.resolvedFrom,
      resolvedTo: input.resolvedTo,
    };
    return this.disputes.listDisputes(criteria, page, size);
  }
}
