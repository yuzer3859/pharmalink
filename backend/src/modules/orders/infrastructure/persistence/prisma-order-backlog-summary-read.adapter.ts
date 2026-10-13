import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IOrderBacklogSummaryReadPort,
  OrderBacklogSummary,
  OrderStatus,
} from '../../application/ports/inbound/order-backlog-summary-read.port';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';

/** The terminal statuses, taken from the state machine rather than listed again. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus).filter((s) => OrderStatusPolicy.isTerminal(s));

interface SummaryRow {
  generatedAt: Date;
  byStatus: Record<string, number> | null;
  total: bigint;
  nonTerminalCount: bigint;
  oldestNonTerminalPlacedAt: Date | null;
  oldestNonTerminalAgeSeconds: bigint | null;
  readyOrderCount: bigint;
  readyOrdersWithDeliveryJob: bigint;
  readyOrdersWithoutDeliveryJob: bigint;
}

/**
 * `IOrderBacklogSummaryReadPort` as **one SQL statement** over `orders` — no join at all, and nothing
 * of payments or deliveries, so each order counts once, and one snapshot for every figure and for
 * `generatedAt`. The terminal set is `OrderStatusPolicy.isTerminal`'s, bound as parameters.
 *
 * The READY handoff split (Work 42) reaches Module 06's own `fulfillments` only through `EXISTS`, so
 * the scan stays one row per order and an order with several fulfillments counts once.
 */
@Injectable()
export class PrismaOrderBacklogSummaryReadAdapter implements IOrderBacklogSummaryReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarizeBacklog(): Promise<OrderBacklogSummary> {
    const nonTerminal = Prisma.sql`o."status"::text NOT IN (${Prisma.join([...TERMINAL_ORDER_STATUSES])})`;
    const placed = Prisma.sql`${nonTerminal} AND o."placedAt" IS NOT NULL`;
    const ready = Prisma.sql`o."status" = 'READY'::"OrderStatus"`;
    const hasJob = Prisma.sql`EXISTS (SELECT 1 FROM "fulfillments" f WHERE f."orderId" = o."id" AND f."deliveryJobId" IS NOT NULL)`;
    const [row] = await this.prisma.$queryRaw<SummaryRow[]>`
      SELECT
        now() AS "generatedAt",
        (SELECT json_object_agg(g."status", g."n")
           FROM (SELECT "status", COUNT(*)::int AS "n" FROM "orders" GROUP BY "status") g) AS "byStatus",
        COUNT(*)::bigint AS "total",
        COUNT(*) FILTER (WHERE ${nonTerminal})::bigint AS "nonTerminalCount",
        MIN(o."placedAt") FILTER (WHERE ${placed}) AS "oldestNonTerminalPlacedAt",
        -- GREATEST ignores NULL, so the no-backlog case is kept NULL explicitly rather than becoming 0.
        CASE WHEN MIN(o."placedAt") FILTER (WHERE ${placed}) IS NULL THEN NULL
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MIN(o."placedAt") FILTER (WHERE ${placed})))))::bigint
        END AS "oldestNonTerminalAgeSeconds",
        COUNT(*) FILTER (WHERE ${ready})::bigint AS "readyOrderCount",
        COUNT(*) FILTER (WHERE ${ready} AND ${hasJob})::bigint AS "readyOrdersWithDeliveryJob",
        COUNT(*) FILTER (WHERE ${ready} AND NOT ${hasJob})::bigint AS "readyOrdersWithoutDeliveryJob"
      FROM "orders" o
    `;
    const stored = row.byStatus ?? {};
    const byStatus = Object.fromEntries(Object.values(OrderStatus).map((s) => [s, Number(stored[s] ?? 0)])) as Record<OrderStatus, number>;
    return {
      generatedAt: row.generatedAt,
      orders: {
        total: Number(row.total),
        byStatus,
        nonTerminalCount: Number(row.nonTerminalCount),
        oldestNonTerminalPlacedAt: row.oldestNonTerminalPlacedAt,
        oldestNonTerminalAgeSeconds: row.oldestNonTerminalAgeSeconds === null ? null : Number(row.oldestNonTerminalAgeSeconds),
      },
      readyHandoff: {
        readyOrderCount: Number(row.readyOrderCount),
        readyOrdersWithDeliveryJob: Number(row.readyOrdersWithDeliveryJob),
        readyOrdersWithoutDeliveryJob: Number(row.readyOrdersWithoutDeliveryJob),
      },
    };
  }
}
