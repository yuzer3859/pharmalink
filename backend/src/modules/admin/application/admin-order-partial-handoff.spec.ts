import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { IOrderOperationsReadPort, OrderOperationsFilter, OrderStatus } from '../../orders/application/ports/inbound/order-operations-read.port';
import { PrismaOrderOperationsReadAdapter } from '../../orders/infrastructure/persistence/prisma-order-operations-read.adapter';
import { AdminOrderOperationsController } from '../interface/controllers/admin-order-operations.controller';
import { ListOrderOperationsQueryDto } from '../interface/dtos/order-operations.dto';
import { toOrderOperationsListResponse } from '../interface/dtos/order-operations.response';
import { ListOrderOperationsQuery } from './queries/order-operations.queries';

const REF = { deliveryJobId: { not: null } };
const UNREF = { deliveryJobId: null };
const row = (id: string, fulfillments: number) => ({
  id, orderNumber: `ORD-${id}`, status: 'READY', isCod: true, grandTotal: 1, currency: 'ETB', placedAt: null,
  createdAt: new Date('2026-10-14T10:00:00Z'), updatedAt: new Date('2026-10-14T10:00:00Z'), _count: { lines: 1, fulfillments },
});

/**
 * Four orders, one per reference shape: `none` (no fulfillment), `all` (2 referenced), `nil` (2 unreferenced)
 * and `mix` (1 referenced, 1 not). The double answers the flag query and the count query as Postgres would.
 */
function fakePrisma() {
  const rows = [row('none', 0), row('all', 2), row('nil', 2), row('mix', 2)];
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let options: unknown;
  const tx = {
    order: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ op: 'findMany', args });
        return (args.select as Record<string, unknown>)._count ? rows : [{ id: 'all' }, { id: 'mix' }];
      },
      count: async (args: Record<string, unknown>) => (calls.push({ op: 'count', args }), rows.length),
    },
    fulfillment: {
      groupBy: async (args: Record<string, unknown>) => (
        calls.push({ op: 'groupBy', args }),
        [{ orderId: 'mix', _count: { _all: 1 } }, { orderId: 'nil', _count: { _all: 2 } }]
      ),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown, o: unknown) => ((options = o), fn(tx)) } as unknown as PrismaService;
  return { prisma, calls, options: () => options };
}

describe('Admin partial fulfillment handoff (Work 44)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListOrderOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('the four reference shapes', () => {
    it('none: 0 / false; all referenced: 0 / true; all unreferenced: 2 / false; mixed: 1 / true', async () => {
      const { prisma } = fakePrisma();
      const page = await new PrismaOrderOperationsReadAdapter(prisma).listOrders({}, 1, 20);
      expect(page.items.map((i) => [i.orderId, i.unreferencedFulfillmentCount, i.hasDeliveryJobReference])).toEqual([
        ['none', 0, false],
        ['all', 0, true],
        ['nil', 2, false],
        ['mix', 1, true],
      ]);
      // Each order is one item whatever its fulfillment count.
      expect(page.items.map((i) => i.fulfillmentCount)).toEqual([0, 2, 2, 2]);
    });
  });

  describe('Module 06 adapter', () => {
    it('the count is ONE GROUP BY over the page’s order ids, counting deliveryJobId IS NULL, inside the same REPEATABLE READ transaction', async () => {
      const { prisma, calls, options } = fakePrisma();
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({}, 1, 20);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls.map((c) => c.op)).toEqual(['findMany', 'count', 'findMany', 'groupBy']);
      expect(calls[3].args).toEqual({ by: ['orderId'], where: { orderId: { in: ['none', 'all', 'nil', 'mix'] }, deliveryJobId: null }, orderBy: { orderId: 'asc' }, _count: { _all: true } });
    });

    it('hasUnreferencedFulfillment true → AND fulfillments.some(null), false → AND fulfillments.none(null); page and total share the where', async () => {
      for (const [flag, rel] of [[true, { some: UNREF }], [false, { none: UNREF }]] as const) {
        const { prisma, calls } = fakePrisma();
        await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ hasUnreferencedFulfillment: flag }, 1, 20);
        expect(calls[0].args.where).toEqual({ AND: [{ fulfillments: rel }] });
        expect(calls[1]).toEqual({ op: 'count', args: { where: { AND: [{ fulfillments: rel }] } } });
      }
    });

    it('both reference filters at once (the partial-handoff query) keep both predicates, with every other filter', async () => {
      const { prisma, calls } = fakePrisma();
      const createdFrom = new Date('2026-10-01T00:00:00Z');
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders(
        { status: OrderStatus.READY, isCod: true, orderNumber: 'ORD-mix', createdFrom, hasDeliveryJobReference: true, hasUnreferencedFulfillment: true }, 2, 10,
      );
      const where = { status: 'READY', isCod: true, orderNumber: 'ORD-mix', createdAt: { gte: createdFrom }, fulfillments: { some: REF }, AND: [{ fulfillments: { some: UNREF } }] };
      expect(calls[0].args).toMatchObject({ where, skip: 10, take: 10 });
      expect(calls[1]).toEqual({ op: 'count', args: { where } });
    });

    it('omitted: the where clause has no AND — existing behaviour, including Work 43’s, is unchanged', async () => {
      const { prisma, calls } = fakePrisma();
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ status: OrderStatus.PAID, hasDeliveryJobReference: false }, 1, 20);
      expect(calls[0].args.where).toEqual({ status: 'PAID', fulfillments: { none: REF } });
    });

    it('an empty page issues neither the flag nor the count query; nothing reads a delivery-job model', async () => {
      const calls: string[] = [];
      const tx = {
        order: { findMany: async () => (calls.push('findMany'), []), count: async () => (calls.push('count'), 0) },
        fulfillment: { groupBy: async () => (calls.push('groupBy'), []) },
      };
      const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as PrismaService;
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ hasUnreferencedFulfillment: true }, 1, 20);
      expect(calls).toEqual(['findMany', 'count']);
      expect(Object.keys(tx)).not.toContain('deliveryJob');
    });
  });

  describe('request and surface', () => {
    it('accepts "true"/"false" only; TRUE, yes, 1, empty and unknown parameters are 400', () => {
      expect(dtoErrors({ hasUnreferencedFulfillment: 'true' })).toEqual([]);
      expect(dtoErrors({ hasUnreferencedFulfillment: 'false', hasDeliveryJobReference: 'true' })).toEqual([]);
      expect(plainToInstance(ListOrderOperationsQueryDto, { hasUnreferencedFulfillment: 'false' }, { enableImplicitConversion: true }).hasUnreferencedFulfillment).toBe('false');
      for (const bad of ['TRUE', 'yes', '1', '', 'no']) expect({ bad, errors: dtoErrors({ hasUnreferencedFulfillment: bad }) }).toEqual({ bad, errors: ['hasUnreferencedFulfillment'] });
      expect(dtoErrors({ hasUnreferenced: 'true' })).toEqual(['hasUnreferenced']);
      expect(dtoErrors({ unreferencedFulfillmentCount: '1' })).toEqual(['unreferencedFulfillmentCount']);
    });

    it('the query forwards the flag exactly; absent stays undefined', async () => {
      const seen: OrderOperationsFilter[] = [];
      const port: IOrderOperationsReadPort = { listOrders: async (f, page, size) => (seen.push(f), { items: [], total: 0, page, size }), getOrder: async () => null };
      const q = new ListOrderOperationsQuery(port);
      await q.execute({});
      await q.execute({ hasUnreferencedFulfillment: false, hasDeliveryJobReference: true });
      expect(seen.map((f) => [f.hasUnreferencedFulfillment, f.hasDeliveryJobReference])).toEqual([[undefined, undefined], [false, true]]);
    });

    it('the list row carries the count as a plain number — no identifiers; still order:read:any', () => {
      const res = toOrderOperationsListResponse({
        items: [{ orderId: 'mix', orderNumber: 'ORD-mix', status: OrderStatus.READY, isCod: true, grandTotal: 1, currency: 'ETB', lineCount: 1, fulfillmentCount: 2, placedAt: null, createdAt: new Date(), updatedAt: new Date(), hasDeliveryJobReference: true, unreferencedFulfillmentCount: 1 }],
        total: 1, page: 1, size: 20,
      });
      expect(res.items[0]).toMatchObject({ hasDeliveryJobReference: true, unreferencedFulfillmentCount: 1 });
      expect(JSON.stringify(res)).not.toMatch(/deliveryJobId|fulfillmentId/);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderOperationsController)).toEqual(['order:read:any']);
    });
  });
});
