import { Injectable } from '@nestjs/common';
import { CodCollectionSummary } from '../../../domain/repositories/cod-collection.repository';
import { ListCodCollectionsQuery } from '../../queries/list-cod-collections.query';

export const COD_FINANCE_READ_PORT = Symbol('COD_FINANCE_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export type { CodCollectionSummary } from '../../../domain/repositories/cod-collection.repository';

/**
 * Module 08's exported contract for **read-only COD finance oversight**, consumed in-process by
 * Module 16 (module-16 Work 07) — one read, and the smallest one that answers "where does the
 * cash stand?".
 *
 * It is the same summary `GET /admin/delivery/cod-reconciliation/summary` serves, over the whole
 * population: count and Σ of the expected, collected and remitted columns, with the outstanding
 * and discrepant subsets counted. Every number is a sum of something a driver or a finance
 * officer wrote down (§18). There is no settlement figure, no fee, no payout and no net here,
 * for the reason that summary's own doc comment gives — Delivery keeps no second set of books.
 *
 * Kept apart from `ICodDisputeAdminPort` on purpose: that port administers disputes, this one
 * reads cash, and a consumer that only needs the second should not be handed the first.
 */
export interface ICodFinanceReadPort {
  /** Totals over every COD collection on record. Filtering stays on Module 08's own route. */
  summarizeCollections(): Promise<CodCollectionSummary>;
}

/** A 1:1 delegation to `ListCodCollectionsQuery.summarize`, owning no logic of its own. */
@Injectable()
export class CodFinanceReadPortAdapter implements ICodFinanceReadPort {
  constructor(private readonly collections: ListCodCollectionsQuery) {}

  summarizeCollections(): Promise<CodCollectionSummary> {
    return this.collections.summarize({});
  }
}
