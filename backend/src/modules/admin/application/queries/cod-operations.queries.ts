import { Inject, Injectable } from '@nestjs/common';
import {
  COD_OPERATIONS_READ_PORT,
  CodOperationsDetail,
  CodOperationsFilter,
  CodOperationsPage,
  ICodOperationsReadPort,
} from '../../../delivery/application/ports/inbound/cod-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_COD_OPERATIONS_PAGE = 1;
export const DEFAULT_COD_OPERATIONS_PAGE_SIZE = 20;
export const MAX_COD_OPERATIONS_PAGE_SIZE = 100;

export interface ListCodOperationsInput extends CodOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/cod` (module-16 Work 38): COD collections, most recently collected first,
 * through Module 08's `COD_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20), as every
 * Module 16 list. Every status, amount and variance is Module 08's. Read-only; not audited.
 */
@Injectable()
export class ListCodOperationsQuery {
  constructor(@Inject(COD_OPERATIONS_READ_PORT) private readonly cod: ICodOperationsReadPort) {}

  execute(input: ListCodOperationsInput): Promise<CodOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_COD_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_COD_OPERATIONS_PAGE_SIZE)
        : DEFAULT_COD_OPERATIONS_PAGE_SIZE;
    const filter: CodOperationsFilter = {
      status: input.status,
      orderId: input.orderId,
      jobId: input.jobId,
      collectedFrom: input.collectedFrom,
      collectedTo: input.collectedTo,
    };
    return this.cod.listCollections(filter, page, size);
  }
}

/**
 * `GET /admin/operations/cod/:collectionId` (module-16 Work 38): one collection with its remittance,
 * reconciliation, corrections and dispute references, from one Module 08 snapshot. Unknown → 404.
 * Read-only; not audited.
 */
@Injectable()
export class GetCodOperationsQuery {
  constructor(@Inject(COD_OPERATIONS_READ_PORT) private readonly cod: ICodOperationsReadPort) {}

  async execute(collectionId: string): Promise<CodOperationsDetail> {
    const collection = await this.cod.getCollection(collectionId);
    if (!collection) throw AdminErrors.codCollectionNotFound();
    return collection;
  }
}
