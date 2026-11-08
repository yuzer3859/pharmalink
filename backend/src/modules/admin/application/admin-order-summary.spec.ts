import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IOrderBacklogSummaryReadPort,
  OrderBacklogSummary,
  OrderStatus,
} from '../../orders/application/ports/inbound/order-backlog-summary-read.port';
import { OrderStatusPolicy } from '../../orders/domain/services/order-status-policy';
import {
  PrismaOrderBacklogSummaryReadAdapter,
  TERMINAL_ORDER_STATUSES,
} from '../../orders/infrastructure/persistence/prisma-order-backlog-summary-read.adapter';
import { AdminModule } from '../admin.module';
import { AdminOrderOperationsController } from '../interface/controllers/admin-order-operations.controller';
import { AdminOrderSummaryController } from '../interface/controllers/admin-order-summary.controller';
import { toOrderBacklogSummaryResponse } from '../interface/dtos/order-backlog-summary.response';
import { GetOrderBacklogSummaryQuery } from './queries/get-order-backlog-summary.query';

const NOW = new Date('2026-10-13T12:00:00Z');
const STATUSES = Object.values(OrderStatus);
type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  generatedAt: NOW, byStatus: null, total: 0n, nonTerminalCount: 0n, oldestNonTerminalPlacedAt: null, oldestNonTerminalAgeSeconds: null,
  readyOrderCount: 0n, readyOrdersWithDeliveryJob: 0n, readyOrdersWithoutDeliveryJob: 0n, ...over,
});

function fakePrisma(result: Row) {
  const statements: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (statements.push(Prisma.sql(strings, ...values)), [result]),
  } as unknown as PrismaService;
  return { prisma, statements };
}

describe('Admin order backlog summary (application)', () => {
  describe('terminal classification — the pharmacy-side backlog (Work 103)', () => {
    it('the backlog ends at the hand-off to delivery; every status in it still has a way forward', () => {
      // Work 103: READY and DISPATCHED now move on as the delivery progresses, so the set is named
      // (before the hand-off) rather than derived from the state machine.
      for (const from of STATUSES.filter((s) => !TERMINAL_ORDER_STATUSES.includes(s))) {
        expect({ from, hasOutgoing: STATUSES.some((to) => OrderStatusPolicy.isLegalTransition(from, to)) }).toEqual({ from, hasOutgoing: true });
      }
      for (const s of ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'] as const) {
        expect({ s, terminal: OrderStatusPolicy.isTerminal(s as never) }).toEqual({ s, terminal: true });
      }
    });

    it('today: DRAFT, PENDING_PAYMENT, PAID, ACCEPTED are in the backlog; READY (the hand-off) and later, CANCELLED, REFUNDED are not', () => {
      expect(STATUSES).toEqual(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'READY', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']);
      expect(STATUSES.filter((s) => !TERMINAL_ORDER_STATUSES.includes(s))).toEqual(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED']);
    });
  });

  describe('Module 06 adapter — mapping', () => {
    it('empty dataset: zeros, all 10 statuses zero-filled in declaration order, oldest timestamp and age null', async () => {
      const s = await new PrismaOrderBacklogSummaryReadAdapter(fakePrisma(row()).prisma).summarizeBacklog();
      expect(s).toEqual({
        generatedAt: NOW,
        orders: { total: 0, byStatus: Object.fromEntries(STATUSES.map((k) => [k, 0])), nonTerminalCount: 0, oldestNonTerminalPlacedAt: null, oldestNonTerminalAgeSeconds: null },
        readyHandoff: { readyOrderCount: 0, readyOrdersWithDeliveryJob: 0, readyOrdersWithoutDeliveryJob: 0 },
      });
      expect(Object.keys(s.orders.byStatus)).toEqual(STATUSES);
    });

    it('mixed counts: stored statuses mapped, missing ones zero-filled; bigints narrowed; oldest and age passed through', async () => {
      const oldest = new Date('2026-10-12T12:00:00Z');
      const s = await new PrismaOrderBacklogSummaryReadAdapter(fakePrisma(row({
        byStatus: { PENDING_PAYMENT: 1, PAID: 2, READY: 3, CANCELLED: 1 }, total: 7n, nonTerminalCount: 3n, oldestNonTerminalPlacedAt: oldest, oldestNonTerminalAgeSeconds: 86_400n,
      })).prisma).summarizeBacklog();
      expect(s.orders).toEqual({
        total: 7,
        byStatus: { DRAFT: 0, PENDING_PAYMENT: 1, PAID: 2, ACCEPTED: 0, READY: 3, DISPATCHED: 0, DELIVERED: 0, COMPLETED: 0, CANCELLED: 1, REFUNDED: 0 },
        nonTerminalCount: 3, oldestNonTerminalPlacedAt: oldest, oldestNonTerminalAgeSeconds: 86_400,
      });
    });
  });

  describe('Module 06 adapter — the statement', () => {
    let statement: Prisma.Sql;
    let sql: string;
    beforeAll(async () => {
      const fake = fakePrisma(row());
      await new PrismaOrderBacklogSummaryReadAdapter(fake.prisma).summarizeBacklog();
      expect(fake.statements).toHaveLength(1); // one statement: one snapshot, generatedAt from the same clock
      statement = fake.statements[0];
      sql = statement.text.replace(/\s+/g, ' ');
    });

    it('reads orders with no join — nothing of payments or deliveries; fulfillments only inside an EXISTS — and generatedAt from now()', () => {
      expect(sql).toContain('now() AS "generatedAt"');
      expect(sql).toMatch(/FROM "orders" o\s*$/);
      expect(sql).not.toMatch(/JOIN|payment|delivery_jobs|cod_/i);
      // Work 42: Module 06's own fulfillments are reached only inside the READY handoff's EXISTS, never as a row source.
      expect(sql.match(/"fulfillments"/g)).toHaveLength(2);
      expect(sql.match(/EXISTS \(SELECT 1 FROM "fulfillments" f WHERE f\."orderId" = o\."id" AND f\."deliveryJobId" IS NOT NULL\)/g)).toHaveLength(2);
    });

    it('non-terminal is "status not in the policy’s terminal set", bound as parameters; the oldest also requires a placedAt', () => {
      expect(new Set(statement.values)).toEqual(new Set(TERMINAL_ORDER_STATUSES));
      expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE o\."status"::text NOT IN \((\$\d+,?)+\)\)::bigint AS "nonTerminalCount"/);
      expect(sql).toMatch(/MIN\(o\."placedAt"\) FILTER \(WHERE o\."status"::text NOT IN \((\$\d+,?)+\) AND o\."placedAt" IS NOT NULL\) AS "oldestNonTerminalPlacedAt"/);
    });

    it('age: floored seconds to the same now(), never negative, NULL (not 0) when there is no qualifying order', () => {
      expect(sql).toMatch(/CASE WHEN MIN\(o\."placedAt"\) FILTER \(WHERE .*?\) IS NULL THEN NULL ELSE GREATEST\(0, FLOOR\(EXTRACT\(EPOCH FROM \(now\(\) - MIN\(o\."placedAt"\)/);
    });

    it('no amount is read or summed', () => {
      expect(sql).not.toMatch(/SUM\(|Total|subtotal|Fee/);
    });
  });

  describe('Module 16 surface', () => {
    it('the query delegates to the port; the response is an explicit allow-list of counts and timestamps', async () => {
      const summary: OrderBacklogSummary = {
        generatedAt: NOW,
        orders: { total: 1, byStatus: Object.fromEntries(STATUSES.map((k) => [k, k === 'PAID' ? 1 : 0])) as Record<OrderStatus, number>, nonTerminalCount: 1, oldestNonTerminalPlacedAt: new Date('2026-10-13T11:00:00Z'), oldestNonTerminalAgeSeconds: 3600 },
        readyHandoff: { readyOrderCount: 0, readyOrdersWithDeliveryJob: 0, readyOrdersWithoutDeliveryJob: 0 },
      };
      Object.assign(summary.orders, { oldestOrderId: 'ord-secret', oldestOrderNumber: 'ORD-SECRET' });
      Object.assign(summary, { grandTotalSum: 999_999, customerUserId: 'cust-secret' });
      const port: IOrderBacklogSummaryReadPort = { summarizeBacklog: async () => summary };
      const res = toOrderBacklogSummaryResponse(await new GetOrderBacklogSummaryQuery(port).execute());
      expect(Object.keys(res)).toEqual(['generatedAt', 'orders', 'readyHandoff']);
      expect(Object.keys(res.orders)).toEqual(['total', 'byStatus', 'nonTerminalCount', 'oldestNonTerminalPlacedAt', 'oldestNonTerminalAgeSeconds']);
      expect(res.orders.oldestNonTerminalPlacedAt).toBe('2026-10-13T11:00:00.000Z');
      expect(JSON.stringify(res)).not.toMatch(/secret|SECRET|999999|Id"|Number"|Total"/);
    });

    it('GET-only under admin/operations/orders/summary with order:read:any, registered before Work 35’s :orderId controller', () => {
      expect(Reflect.getMetadata('path', AdminOrderSummaryController)).toBe('admin/operations/orders/summary');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderSummaryController)).toEqual(['order:read:any']);
      expect(Object.getOwnPropertyNames(AdminOrderSummaryController.prototype).filter((m) => m !== 'constructor')).toEqual(['get']);
      expect(Reflect.getMetadata('method', AdminOrderSummaryController.prototype.get)).toBe(0);
      const controllers = Reflect.getMetadata('controllers', AdminModule) as unknown[];
      expect(controllers.indexOf(AdminOrderSummaryController)).toBeGreaterThanOrEqual(0);
      expect(controllers.indexOf(AdminOrderSummaryController)).toBeLessThan(controllers.indexOf(AdminOrderOperationsController));
    });
  });
});
