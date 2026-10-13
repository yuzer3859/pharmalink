import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { OrderBacklogSummary, OrderStatus } from '../../orders/application/ports/inbound/order-backlog-summary-read.port';
import { PrismaOrderBacklogSummaryReadAdapter } from '../../orders/infrastructure/persistence/prisma-order-backlog-summary-read.adapter';
import { AdminOrderSummaryController } from '../interface/controllers/admin-order-summary.controller';
import { toOrderBacklogSummaryResponse } from '../interface/dtos/order-backlog-summary.response';

const NOW = new Date('2026-10-14T12:00:00Z');
type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  generatedAt: NOW, byStatus: null, total: 0n, nonTerminalCount: 0n, oldestNonTerminalPlacedAt: null, oldestNonTerminalAgeSeconds: null,
  readyOrderCount: 0n, readyOrdersWithDeliveryJob: 0n, readyOrdersWithoutDeliveryJob: 0n, ...over,
});

async function run(result: Row) {
  const statements: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (statements.push(Prisma.sql(strings, ...values)), [result]),
  } as unknown as PrismaService;
  const summary = await new PrismaOrderBacklogSummaryReadAdapter(prisma).summarizeBacklog();
  return { summary, statements, sql: statements[0].text.replace(/\s+/g, ' ') };
}
const handoff = (ready: bigint, withJob: bigint, without: bigint) => ({ readyOrderCount: ready, readyOrdersWithDeliveryJob: withJob, readyOrdersWithoutDeliveryJob: without });

describe('Admin order delivery handoff (Work 42)', () => {
  describe('mapping', () => {
    it.each([
      ['no READY orders', handoff(0n, 0n, 0n), [0, 0, 0]],
      ['every READY order without a reference', handoff(3n, 0n, 3n), [3, 0, 3]],
      ['every READY order with a reference', handoff(2n, 2n, 0n), [2, 2, 0]],
      ['a mixture', handoff(5n, 2n, 3n), [5, 2, 3]],
    ] as const)('%s', async (_name, counts, expected) => {
      const { summary } = await run(row(counts));
      const h = summary.readyHandoff;
      expect([h.readyOrderCount, h.readyOrdersWithDeliveryJob, h.readyOrdersWithoutDeliveryJob]).toEqual(expected);
      expect(h.readyOrdersWithDeliveryJob + h.readyOrdersWithoutDeliveryJob).toBe(h.readyOrderCount);
    });
  });

  describe('the statement', () => {
    let sql: string;
    let statements: Prisma.Sql[];
    beforeAll(async () => {
      ({ sql, statements } = await run(row()));
    });

    it('one statement over orders with no join — the READY split shares the snapshot and generatedAt of every Work 41 figure', () => {
      expect(statements).toHaveLength(1);
      expect(sql).toMatch(/FROM "orders" o\s*$/);
      expect(sql).not.toMatch(/JOIN/i);
    });

    it('READY is the stored status exactly; other statuses are excluded from all three figures', () => {
      const ready = `o."status" = 'READY'::"OrderStatus"`;
      expect(sql).toContain(`COUNT(*) FILTER (WHERE ${ready})::bigint AS "readyOrderCount"`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE ${ready} AND EXISTS`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE ${ready} AND NOT EXISTS`);
    });

    it('per order through EXISTS over its fulfillments — several fulfillments never count an order twice — and with/without are exact complements', () => {
      const exists = 'EXISTS (SELECT 1 FROM "fulfillments" f WHERE f."orderId" = o."id" AND f."deliveryJobId" IS NOT NULL)';
      expect(sql).toContain(`AND ${exists})::bigint AS "readyOrdersWithDeliveryJob"`);
      expect(sql).toContain(`AND NOT ${exists})::bigint AS "readyOrdersWithoutDeliveryJob"`);
      expect(sql).not.toMatch(/COUNT\(DISTINCT|COUNT\(f\./);
    });

    it('the reference alone — no delivery-job table, status or driver is read', () => {
      expect(sql).not.toMatch(/delivery_jobs|assignedDriverId|DeliveryJobStatus/);
    });

    it('Work 41’s figures keep exactly their definitions: the READY split adds no condition to them', () => {
      expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE o\."status"::text NOT IN \((\$\d+,?)+\)\)::bigint AS "nonTerminalCount"/);
      expect(sql).toMatch(/MIN\(o\."placedAt"\) FILTER \(WHERE o\."status"::text NOT IN \((\$\d+,?)+\) AND o\."placedAt" IS NOT NULL\) AS "oldestNonTerminalPlacedAt"/);
      expect(sql).toContain('COUNT(*)::bigint AS "total"');
      // READY stays terminal: it is one of the bound terminal statuses, so it never reaches nonTerminalCount.
      expect(statements[0].values).toContain('READY');
    });
  });

  describe('Module 16 surface', () => {
    it('the response adds readyHandoff beside the unchanged orders section, as an explicit allow-list of three counts', async () => {
      const summary: OrderBacklogSummary = {
        generatedAt: NOW,
        orders: { total: 3, byStatus: Object.fromEntries(Object.values(OrderStatus).map((k) => [k, k === 'READY' ? 3 : 0])) as Record<OrderStatus, number>, nonTerminalCount: 0, oldestNonTerminalPlacedAt: null, oldestNonTerminalAgeSeconds: null },
        readyHandoff: { readyOrderCount: 3, readyOrdersWithDeliveryJob: 1, readyOrdersWithoutDeliveryJob: 2 },
      };
      Object.assign(summary.readyHandoff, { orderIds: ['o-secret'], deliveryJobIds: ['job-secret'], deliveryStatus: 'EN_ROUTE' });
      const res = toOrderBacklogSummaryResponse(summary);
      expect(Object.keys(res)).toEqual(['generatedAt', 'orders', 'readyHandoff']);
      expect(res.readyHandoff).toEqual({ readyOrderCount: 3, readyOrdersWithDeliveryJob: 1, readyOrdersWithoutDeliveryJob: 2 });
      expect(res.orders).toEqual({ total: 3, byStatus: expect.objectContaining({ READY: 3 }), nonTerminalCount: 0, oldestNonTerminalPlacedAt: null, oldestNonTerminalAgeSeconds: null });
      expect(JSON.stringify(res)).not.toMatch(/secret|EN_ROUTE|Ids"|deliveryStatus/);
    });

    it('still one GET route under order:read:any', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderSummaryController)).toEqual(['order:read:any']);
      expect(Object.getOwnPropertyNames(AdminOrderSummaryController.prototype).filter((m) => m !== 'constructor')).toEqual(['get']);
      expect(Reflect.getMetadata('method', AdminOrderSummaryController.prototype.get)).toBe(0);
    });
  });
});
