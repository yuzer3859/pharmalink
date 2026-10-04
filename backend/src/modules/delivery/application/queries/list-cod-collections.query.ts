import { Inject, Injectable } from '@nestjs/common';
import { hasDiscrepancy, varianceOf } from '../../domain/entities/cod-collection.entity';
import { CodCollectionStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import {
  COD_COLLECTION_REPOSITORY,
  CodCollectionSummary,
  CodCollectionRecord,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';

/** The largest page this read will return. Matches the other admin lists in the project. */
export const MAX_COD_COLLECTION_PAGE_SIZE = 100;

/**
 * One collection as finance sees it: the three legs, and the two gaps between them.
 *
 * The variances are computed here rather than stored, exactly as `CodCollectionView`'s are and for
 * the same reason — a persisted copy of a subtraction is a third number that can disagree with the
 * two it came from.
 */
export interface CodReconciliationView extends CodCollectionRecord {
  /** `collectedAmount − expectedAmount`. Negative means the customer paid less than the order. */
  collectionVariance: number;
  /** `remittedAmount − collectedAmount`, or `null` while nothing has been remitted. */
  remittanceVariance: number | null;
  /** Whether either gap is non-zero. The one boolean a queue filters on. */
  hasDiscrepancy: boolean;
  /** Whether PharmaLink still owes this collection a step. */
  isOutstanding: boolean;
}

export interface CodReconciliationPageView {
  items: CodReconciliationView[];
  total: number;
  page: number;
  size: number;
}

export interface ListCodCollectionsInput {
  driverId?: string;
  status?: CodCollectionStatus;
  currency?: string;
  /** Exact match on a handover handle: every collection remitted under one reference. */
  remittanceReference?: string;
  orderId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  size?: number;
}

/**
 * The finance and operations view of COD cash (§18, §19, §9.5's
 * `GET /admin/delivery/cod-reconciliation`).
 *
 * ## The questions §18 asks, and where each answer comes from
 *
 * | Question | Field |
 * | --- | --- |
 * | What was expected? | `collection.expectedAmount`, frozen from the order at job creation |
 * | What did the driver declare? | `collection.collectedAmount` |
 * | What was remitted? | `remittance.remittedAmount`, or `null` |
 * | What remains to be reconciled? | `isOutstanding`, and the `status` filter |
 * | Was there a discrepancy? | `collectionVariance`, `remittanceVariance`, `hasDiscrepancy` |
 * | Who recorded each step? | `collection.driverId`, `remittance.confirmedByUserId`, `reconciliation.reconciledByUserId` |
 * | When did each step occur? | `collectedAt`/`recordedAt`, `remittedAt`, `reconciledAt` |
 * | What reference supports the remittance? | `remittance.reference` |
 *
 * Every one of them is a column on a row somebody wrote. Nothing here recomputes a figure at read
 * time, and there is deliberately no aggregate total: a sum over a filtered page is the kind of
 * number that gets quoted as a balance, and this module has no balance to report.
 *
 * ## Platform-scoped, and deliberately so
 *
 * These reads are **not** narrowed to an organization. `finance:report:any` and
 * `finance:settlement:any` are platform authority — the same position
 * `AdminSettlementController` takes, and for the same reason: a finance officer scoped to whatever
 * pharmacies they happened to own would see nothing at all. COD cash is owed by a delivery channel
 * to PharmaLink, not to a pharmacy, so there is no organization it could sensibly be scoped to; the
 * pharmacy's side of the money is a Module 07 settlement computed from the order.
 *
 * An unknown id answers `NOT_FOUND` through the same error the driver-facing read uses, so this
 * surface leaks nothing a caller without platform authority could have used.
 *
 * ## What a finance reader is *not* shown
 *
 * `driverId` is a `driver_profiles.id` and that is the whole of what this view says about the
 * channel — no name, no phone, no bank detail, no earnings, no payout history, no other delivery.
 * §18's "do not expose driver financial information beyond the COD collection facts required by the
 * finance role" is satisfied by the query never joining `driver_earnings` at all: what a driver is
 * *owed* and what a driver is *holding* are unrelated amounts, and a view that showed both beside
 * each other would invite somebody to net them.
 *
 * ## Batch preparation without a batch engine
 *
 * §19 asks for grouping capability, not a settlement run. The filters are exactly the five it
 * names — channel, period, status, currency, remittance reference — and `remittanceReference` is
 * what reconstructs a day's handover, because a real remittance is one driver handing over many
 * collections under one handle. No cadence is assumed anywhere: nothing here schedules, nothing
 * defaults a period, and there is no "today's batch" concept to be wrong about.
 */
@Injectable()
export class ListCodCollectionsQuery {
  constructor(
    @Inject(COD_COLLECTION_REPOSITORY) private readonly collections: ICodCollectionRepository,
  ) {}

  async execute(input: ListCodCollectionsInput = {}): Promise<CodReconciliationPageView> {
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const size = Math.min(
      MAX_COD_COLLECTION_PAGE_SIZE,
      Math.max(1, Math.trunc(input.size ?? 20)),
    );

    const result = await this.collections.search({
      driverId: normalize(input.driverId),
      status: input.status,
      currency: normalize(input.currency)?.toUpperCase(),
      remittanceReference: normalize(input.remittanceReference),
      orderId: normalize(input.orderId),
      from: input.from,
      to: input.to,
      page,
      size,
    });

    return {
      items: result.items.map(toView),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  }

  /**
   * Totals over the same population `execute` would page (§18, §19's grouping).
   *
   * The questions this answers are the ones a page cannot: "how much COD is outstanding right
   * now?", "how much did this driver hand over under that reference?", "how many of yesterday's
   * collections disagree with expectation?". Every one of them spans the whole filtered set, and a
   * finance officer paging through a hundred rows at a time to add up a column is doing the
   * database's job by hand.
   *
   * It takes **the same input type** as `execute`, minus paging. That is deliberate and it is the
   * property that makes the number trustworthy: a summary reachable only through different filters
   * than the list it heads would eventually disagree with it, and the disagreement would be
   * invisible.
   *
   * It is not a settlement run. Nothing here schedules, nothing assumes a cadence, nothing writes,
   * and there is no batch — §19 asks for grouping capability, and a `remittanceReference` filter
   * over stored rows is what reconstructs a day's handover without inventing a table to hold one.
   */
  async summarize(input: ListCodCollectionsInput = {}): Promise<CodCollectionSummary> {
    return this.collections.summarize({
      driverId: normalize(input.driverId),
      status: input.status,
      currency: normalize(input.currency)?.toUpperCase(),
      remittanceReference: normalize(input.remittanceReference),
      orderId: normalize(input.orderId),
      from: input.from,
      to: input.to,
    });
  }

  /** One collection with both of its later legs. `NOT_FOUND` when there is no such collection. */
  async byId(collectionId: string): Promise<CodReconciliationView> {
    const id = (collectionId ?? '').trim();
    if (!id) {
      throw DeliveryErrors.validation('collectionId is required.', { field: 'collectionId' });
    }
    const record = await this.collections.findRecordById(id);
    if (!record) {
      throw DeliveryErrors.codCollectionNotFound(id);
    }
    return toView(record);
  }
}

/**
 * Projects a stored record into what finance reads.
 *
 * `remittanceVariance` is `null` rather than `0` while nothing has been remitted, and the
 * distinction matters: `0` would say "everything that was declared arrived", which is precisely
 * what has *not* been established about a collection nobody has handed over.
 *
 * `isOutstanding` is "not yet reconciled" — a collection is outstanding from the moment the driver
 * records it until PharmaLink has checked it, whatever the finding was. A `DISCREPANCY` is
 * therefore **not** outstanding: somebody looked, and what happens next is a commercial decision
 * this module does not make. `hasDiscrepancy` is the field a follow-up queue filters on.
 */
function toView(record: CodCollectionRecord): CodReconciliationView {
  const collectionVariance = varianceOf(record.collection);
  const remittanceVariance = record.remittance
    ? record.remittance.remittedAmount - record.collection.collectedAmount
    : null;

  return {
    ...record,
    collectionVariance,
    remittanceVariance,
    hasDiscrepancy: hasDiscrepancy(record.collection) || (remittanceVariance ?? 0) !== 0,
    isOutstanding: record.collection.status !== CodCollectionStatus.RECONCILED,
  };
}

function normalize(value?: string): string | undefined {
  const text = (value ?? '').trim();
  return text.length === 0 ? undefined : text;
}
