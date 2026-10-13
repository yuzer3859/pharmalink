import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliveryBacklogSummary,
  DeliveryJobStatus,
  IDeliveryBacklogSummaryReadPort,
} from '../../application/ports/inbound/delivery-backlog-summary-read.port';
import { DeliveryStatusPolicy } from '../../domain/services/delivery-status-policy';

/** The terminal statuses, taken from the state machine rather than listed again. */
export const TERMINAL_DELIVERY_JOB_STATUSES: readonly DeliveryJobStatus[] = Object.values(DeliveryJobStatus).filter((s) =>
  DeliveryStatusPolicy.isTerminal(s),
);

interface SummaryRow {
  generatedAt: Date;
  byStatus: Record<string, number> | null;
  total: bigint;
  nonTerminalCount: bigint;
  oldestNonTerminalCreatedAt: Date | null;
  oldestNonTerminalAgeSeconds: bigint | null;
  unassignedCount: bigint;
}

/**
 * `IDeliveryBacklogSummaryReadPort` as **one SQL statement** over `delivery_jobs` alone — no join, so
 * nothing can be multiplied, and one snapshot for every figure and for `generatedAt`. The terminal
 * set is `DeliveryStatusPolicy.isTerminal`'s, bound as parameters.
 */
@Injectable()
export class PrismaDeliveryBacklogSummaryReadAdapter implements IDeliveryBacklogSummaryReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeBacklog(): Promise<DeliveryBacklogSummary> {
    const nonTerminal = Prisma.sql`j."status"::text NOT IN (${Prisma.join([...TERMINAL_DELIVERY_JOB_STATUSES])})`;
    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      SELECT
        now() AS "generatedAt",
        (SELECT json_object_agg(g."status", g."n")
           FROM (SELECT "status", COUNT(*)::int AS "n" FROM "delivery_jobs" GROUP BY "status") g) AS "byStatus",
        COUNT(*)::bigint AS "total",
        COUNT(*) FILTER (WHERE ${nonTerminal})::bigint AS "nonTerminalCount",
        MIN(j."createdAt") FILTER (WHERE ${nonTerminal}) AS "oldestNonTerminalCreatedAt",
        -- GREATEST ignores NULL, so the no-backlog case is kept NULL explicitly rather than becoming 0.
        CASE WHEN MIN(j."createdAt") FILTER (WHERE ${nonTerminal}) IS NULL THEN NULL
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MIN(j."createdAt") FILTER (WHERE ${nonTerminal})))))::bigint
        END AS "oldestNonTerminalAgeSeconds",
        COUNT(*) FILTER (WHERE ${nonTerminal} AND j."assignedDriverId" IS NULL)::bigint AS "unassignedCount"
      FROM "delivery_jobs" j
    `;
    const stored = row.byStatus ?? {};
    const byStatus = Object.fromEntries(Object.values(DeliveryJobStatus).map((s) => [s, Number(stored[s] ?? 0)])) as Record<DeliveryJobStatus, number>;
    return {
      generatedAt: row.generatedAt,
      jobs: {
        total: Number(row.total),
        byStatus,
        nonTerminalCount: Number(row.nonTerminalCount),
        oldestNonTerminalCreatedAt: row.oldestNonTerminalCreatedAt,
        oldestNonTerminalAgeSeconds: row.oldestNonTerminalAgeSeconds === null ? null : Number(row.oldestNonTerminalAgeSeconds),
      },
      assignment: { unassignedCount: Number(row.unassignedCount) },
    };
  }
}
