import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CatalogReviewSummaryView,
  ICatalogReviewSummaryReadPort,
} from '../../application/ports/inbound/catalog-review-summary-read.port';
import { PRODUCT_AUDIT_RESOURCE_TYPE, PRODUCT_STATUS_CHANGED_ACTION } from '../../domain/audit-actions';
import { ProductStatus } from '../../domain/enums';

/** Module 03's own status-change entries in the shared trail (written by `ChangeProductStatusCommand`). */
const STATUS_CHANGES = Prisma.sql`a."action" = ${PRODUCT_STATUS_CHANGED_ACTION} AND a."resourceType" = ${PRODUCT_AUDIT_RESOURCE_TYPE}`;

/**
 * `ICatalogReviewSummaryReadPort` over PostgreSQL — aggregates only, in one `REPEATABLE READ`
 * transaction so the queue and the decision counts describe one snapshot. Read-only: `SELECT`s, no
 * other statement. It reads `audit_logs` directly, for the one reason a join requires it — a pending
 * product's wait start is its latest entry into `PENDING_REVIEW`, which needs `products` and its own
 * status-change entries together — and only the `PRODUCT_STATUS_CHANGED` / `Product` entries Module 03
 * writes. `context ->> 'from' / 'to'` is `NULL` for an entry whose context is not an object carrying
 * them, so a malformed entry matches nothing.
 */
@Injectable()
export class PrismaCatalogReviewSummaryReadAdapter implements ICatalogReviewSummaryReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeReview(): Promise<CatalogReviewSummaryView> {
    const PENDING = ProductStatus.PENDING_REVIEW;
    const [[queue], [decisions]] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<Array<{ pending: bigint; unrecorded: bigint; oldest: Date | null }>>`
          SELECT COUNT(*) AS "pending",
                 COUNT(*) FILTER (WHERE w."waitingSince" IS NULL) AS "unrecorded",
                 MIN(w."waitingSince") AS "oldest"
          FROM (
            SELECT p."id",
                   (SELECT MAX(a."createdAt") FROM "audit_logs" a
                     WHERE ${STATUS_CHANGES} AND a."resourceId" = p."id"
                       AND a."context" ->> 'to' = ${PENDING}) AS "waitingSince"
            FROM "products" p
            WHERE p."status" = ${PENDING}::"ProductStatus" AND p."deletedAt" IS NULL
          ) w`,
        this.prisma.$queryRaw<Array<{ approvals: bigint; rejections: bigint; resubmissions: bigint }>>`
          SELECT
            COUNT(*) FILTER (WHERE a."context" ->> 'from' = ${PENDING} AND a."context" ->> 'to' = ${ProductStatus.ACTIVE}) AS "approvals",
            COUNT(*) FILTER (WHERE a."context" ->> 'from' = ${PENDING} AND a."context" ->> 'to' = ${ProductStatus.REJECTED}) AS "rejections",
            COUNT(*) FILTER (WHERE a."context" ->> 'from' = ${ProductStatus.REJECTED} AND a."context" ->> 'to' = ${PENDING}) AS "resubmissions"
          FROM "audit_logs" a
          WHERE ${STATUS_CHANGES}`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      pendingReviewCount: Number(queue.pending),
      pendingWithoutRecordedSubmission: Number(queue.unrecorded),
      oldestPendingSubmittedAt: queue.oldest,
      approvals: Number(decisions.approvals),
      rejections: Number(decisions.rejections),
      resubmissions: Number(decisions.resubmissions),
    };
  }
}
