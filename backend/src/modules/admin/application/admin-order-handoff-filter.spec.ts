import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  IOrderOperationsReadPort,
  OrderOperationsDetail,
  OrderOperationsFilter,
  OrderStatus,
} from '../../orders/application/ports/inbound/order-operations-read.port';
import { PrismaOrderOperationsReadAdapter } from '../../orders/infrastructure/persistence/prisma-order-operations-read.adapter';
import { AdminOrderOperationsController } from '../interface/controllers/admin-order-operations.controller';
import { ListOrderOperationsQueryDto } from '../interface/dtos/order-operations.dto';
import { toOrderOperationsDetailResponse, toOrderOperationsListResponse } from '../interface/dtos/order-operations.response';
import { ListOrderOperationsQuery } from './queries/order-operations.queries';

const REF = { deliveryJobId: { not: null } };
const row = (id: string) => ({
  id, orderNumber: `ORD-${id}`, status: 'READY', isCod: true, grandTotal: 1, currency: 'ETB', placedAt: null,
  createdAt: new Date('2026-10-14T10:00:00Z'), updatedAt: new Date('2026-10-14T10:00:00Z'), _count: { lines: 1, fulfillments: 2 },
});

/** A transaction client double recording every call; `referenced` is what the flag query finds. */
function fakePrisma(rows: ReturnType<typeof row>[], referenced: string[]) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let options: unknown;
  const tx = {
    order: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ op: 'findMany', args });
        return 'select' in args && (args.select as Record<string, unknown>)._count ? rows : referenced.map((id) => ({ id }));
      },
      count: async (args: Record<string, unknown>) => (calls.push({ op: 'count', args }), rows.length),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown, o: unknown) => ((options = o), fn(tx)) } as unknown as PrismaService;
  return { prisma, calls, options: () => options };
}

describe('Admin order handoff exception filtering (Work 43)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListOrderOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('request', () => {
    it('accepts "true"/"false" as raw strings (never coerced); anything else and unknown parameters are 400', () => {
      expect(dtoErrors({ hasDeliveryJobReference: 'true' })).toEqual([]);
      expect(dtoErrors({ hasDeliveryJobReference: 'false' })).toEqual([]);
      expect(plainToInstance(ListOrderOperationsQueryDto, { hasDeliveryJobReference: 'false' }, { enableImplicitConversion: true }).hasDeliveryJobReference).toBe('false');
      for (const bad of ['yes', '1', '0', 'TRUE', '', 'null']) expect({ bad, errors: dtoErrors({ hasDeliveryJobReference: bad }) }).toEqual({ bad, errors: ['hasDeliveryJobReference'] });
      expect(dtoErrors({ hasDeliveryJob: 'true' })).toEqual(['hasDeliveryJob']);
      expect(dtoErrors({ deliveryJobId: 'x' })).toEqual(['deliveryJobId']);
    });

    it('the query forwards the flag exactly; absent stays undefined, so existing behaviour is unchanged', async () => {
      const seen: OrderOperationsFilter[] = [];
      const port: IOrderOperationsReadPort = { listOrders: async (f, page, size) => (seen.push(f), { items: [], total: 0, page, size }), getOrder: async () => null };
      const q = new ListOrderOperationsQuery(port);
      await q.execute({});
      await q.execute({ status: OrderStatus.READY, hasDeliveryJobReference: false });
      await q.execute({ hasDeliveryJobReference: true });
      expect(seen.map((f) => f.hasDeliveryJobReference)).toEqual([undefined, false, true]);
      expect(seen[1]).toMatchObject({ status: 'READY', hasDeliveryJobReference: false });
    });
  });

  describe('Module 06 adapter', () => {
    it('no flag: the where clause is exactly what it was — no fulfillment predicate', async () => {
      const { prisma, calls } = fakePrisma([], []);
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ status: OrderStatus.PAID }, 1, 20);
      expect(calls[0].args.where).toEqual({ status: 'PAID' });
      expect(calls[1]).toEqual({ op: 'count', args: { where: { status: 'PAID' } } });
    });

    it('true → fulfillments.some, false → fulfillments.none (both "deliveryJobId not null"), composed with every other filter; page and total share the where', async () => {
      for (const [flag, rel] of [[true, { some: REF }], [false, { none: REF }]] as const) {
        const { prisma, calls } = fakePrisma([], []);
        const createdFrom = new Date('2026-10-01T00:00:00Z');
        const createdTo = new Date('2026-10-15T00:00:00Z');
        await new PrismaOrderOperationsReadAdapter(prisma).listOrders(
          { status: OrderStatus.READY, isCod: true, orderNumber: 'ORD-1', createdFrom, createdTo, hasDeliveryJobReference: flag }, 3, 5,
        );
        const where = { status: 'READY', isCod: true, orderNumber: 'ORD-1', createdAt: { gte: createdFrom, lt: createdTo }, fulfillments: rel };
        expect(calls[0].args).toMatchObject({ where, skip: 10, take: 5, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
        expect(calls[1]).toEqual({ op: 'count', args: { where } });
      }
    });

    it('the row flag: ONE query over the page’s ids with the same predicate — any referenced fulfillment makes the order true; no fulfillment row is read', async () => {
      const { prisma, calls, options } = fakePrisma([row('a'), row('b'), row('c')], ['a', 'c']);
      const page = await new PrismaOrderOperationsReadAdapter(prisma).listOrders({}, 1, 20);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls.filter((c) => c.op === 'findMany')).toHaveLength(2);
      expect(calls[2].args).toEqual({ where: { id: { in: ['a', 'b', 'c'] }, fulfillments: { some: REF } }, select: { id: true } });
      expect(page.items.map((i) => [i.orderId, i.hasDeliveryJobReference])).toEqual([['a', true], ['b', false], ['c', true]]);
      // An order with two fulfillments is still one item (fulfillmentCount 2, one row).
      expect(page.items.map((i) => i.fulfillmentCount)).toEqual([2, 2, 2]);
    });

    it('an empty page issues no flag query', async () => {
      const { prisma, calls } = fakePrisma([], []);
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ hasDeliveryJobReference: false }, 1, 20);
      expect(calls.map((c) => c.op)).toEqual(['findMany', 'count']);
    });

    it('only Module 06’s order client is used — no delivery-job model, no raw SQL', async () => {
      const { prisma, calls } = fakePrisma([row('a')], []);
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ hasDeliveryJobReference: true }, 1, 20);
      expect(JSON.stringify(calls)).not.toMatch(/deliveryJob"|delivery_jobs|\$queryRaw/);
    });
  });

  describe('Module 16 surface', () => {
    it('list rows carry the boolean; the detail response is unchanged (no such field)', () => {
      const res = toOrderOperationsListResponse({
        items: [{ orderId: 'a', orderNumber: 'ORD-a', status: OrderStatus.READY, isCod: true, grandTotal: 1, currency: 'ETB', lineCount: 1, fulfillmentCount: 2, placedAt: null, createdAt: new Date(), updatedAt: new Date(), hasDeliveryJobReference: true }],
        total: 1, page: 1, size: 20,
      });
      expect(res.items[0].hasDeliveryJobReference).toBe(true);
      expect(JSON.stringify(res)).not.toMatch(/deliveryJobId|fulfillmentId/);
      const detail: OrderOperationsDetail = {
        orderId: 'a', orderNumber: 'ORD-a', status: OrderStatus.READY, isCod: true, grandTotal: 1, currency: 'ETB', lineCount: 1, fulfillmentCount: 0, placedAt: null,
        createdAt: new Date(), updatedAt: new Date(), subtotal: 1, deliveryFee: 0, platformFee: 0, discountTotal: 0, completedAt: null, cancelledAt: null, paymentId: null, fulfillments: [],
      };
      expect(toOrderOperationsDetailResponse({ order: detail, payment: null })).not.toHaveProperty('hasDeliveryJobReference');
    });

    it('still order:read:any, still GET-only', () => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderOperationsController)).toEqual(['order:read:any']);
      expect(Reflect.getMetadata('method', AdminOrderOperationsController.prototype.search)).toBe(0);
    });
  });
});
