import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  CodCollectionStatus,
  CodExceptionSummary,
  ICodExceptionSummaryReadPort,
} from '../../application/ports/inbound/cod-exception-summary-read.port';
import { COD_DISCREPANCY_SQL, COD_OUTSTANDING_SQL } from './cod-collection.sql';

interface SummaryRow {
  generatedAt: Date;
  byStatus: Record<string, number> | null;
  total: bigint;
  outstandingCount: bigint;
  oldestOutstandingCollectedAt: Date | null;
  oldestOutstandingAgeSeconds: bigint | null;
  discrepancyCount: bigint;
  reconciliationDiscrepancyCount: bigint;
  collectionsWithCorrectionsCount: bigint;
  collectionsWithOpenDisputesCount: bigint;
  openDisputeCount: bigint;
}

/**
 * `ICodExceptionSummaryReadPort` as **one SQL statement**, so every figure — and `generatedAt` — comes
 * from a single snapshot (the same reasoning `PrismaCodCollectionRepository.summarize` records).
 *
 * The collection scan joins only the two legs that are unique per collection (`cod_remittances`,
 * `cod_reconciliations`), so no row is multiplied. Corrections and disputes are reached through
 * `EXISTS`, which counts a collection once however many rows it has; open disputes themselves are
 * counted in their own sub-select over `cod_disputes` (served by its `(status, openedAt)` index).
 * Nothing is loaded into memory but the one result row.
 */
@Injectable()
export class PrismaCodExceptionSummaryReadAdapter implements ICodExceptionSummaryReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeExceptions(): Promise<CodExceptionSummary> {
    const open = Prisma.sql`'OPEN'::"CodDisputeStatus"`;
    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      SELECT
        now() AS "generatedAt",
        (SELECT json_object_agg(g."status", g."n")
           FROM (SELECT "status", COUNT(*)::int AS "n" FROM "cod_collections" GROUP BY "status") g) AS "byStatus",
        COUNT(c."id")::bigint AS "total",
        COUNT(c."id") FILTER (WHERE ${COD_OUTSTANDING_SQL})::bigint AS "outstandingCount",
        MIN(c."collectedAt") FILTER (WHERE ${COD_OUTSTANDING_SQL}) AS "oldestOutstandingCollectedAt",
        -- GREATEST ignores NULL, so the no-outstanding case is kept NULL explicitly rather than becoming 0.
        CASE WHEN MIN(c."collectedAt") FILTER (WHERE ${COD_OUTSTANDING_SQL}) IS NULL THEN NULL
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MIN(c."collectedAt") FILTER (WHERE ${COD_OUTSTANDING_SQL})))))::bigint
        END AS "oldestOutstandingAgeSeconds",
        COUNT(c."id") FILTER (WHERE ${COD_DISCREPANCY_SQL})::bigint AS "discrepancyCount",
        COUNT(c."id") FILTER (WHERE rc."outcome" = 'DISCREPANCY'::"CodReconciliationOutcome")::bigint AS "reconciliationDiscrepancyCount",
        COUNT(c."id") FILTER (
          WHERE EXISTS (SELECT 1 FROM "cod_corrections" x WHERE x."collectionId" = c."id")
        )::bigint AS "collectionsWithCorrectionsCount",
        COUNT(c."id") FILTER (
          WHERE EXISTS (SELECT 1 FROM "cod_disputes" d WHERE d."collectionId" = c."id" AND d."status" = ${open})
        )::bigint AS "collectionsWithOpenDisputesCount",
        (SELECT COUNT(*) FROM "cod_disputes" d WHERE d."status" = ${open})::bigint AS "openDisputeCount"
      FROM "cod_collections" c
      LEFT JOIN "cod_remittances" r ON r."collectionId" = c."id"
      LEFT JOIN "cod_reconciliations" rc ON rc."collectionId" = c."id"
    `;
    const stored = row.byStatus ?? {};
    const byStatus = Object.fromEntries(Object.values(CodCollectionStatus).map((s) => [s, Number(stored[s] ?? 0)])) as Record<CodCollectionStatus, number>;
    return {
      generatedAt: row.generatedAt,
      collections: {
        total: Number(row.total),
        byStatus,
        outstandingCount: Number(row.outstandingCount),
        oldestOutstandingCollectedAt: row.oldestOutstandingCollectedAt,
        oldestOutstandingAgeSeconds: row.oldestOutstandingAgeSeconds === null ? null : Number(row.oldestOutstandingAgeSeconds),
      },
      exceptions: {
        discrepancyCount: Number(row.discrepancyCount),
        reconciliationDiscrepancyCount: Number(row.reconciliationDiscrepancyCount),
        collectionsWithCorrectionsCount: Number(row.collectionsWithCorrectionsCount),
        collectionsWithOpenDisputesCount: Number(row.collectionsWithOpenDisputesCount),
        openDisputeCount: Number(row.openDisputeCount),
      },
    };
  }
}
