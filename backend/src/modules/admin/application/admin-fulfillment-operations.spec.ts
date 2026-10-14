import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import {
  FulfillmentOperationsFilter,
  FulfillmentOperationsView,
  FulfillmentStatus,
  IFulfillmentOperationsReadPort,
} from '../../orders/application/ports/inbound/fulfillment-operations-read.port';
import { PrismaFulfillmentOperationsReadAdapter } from '../../orders/infrastructure/persistence/prisma-fulfillment-operations-read.adapter';
import { AdminFulfillmentOperationsController } from '../interface/controllers/admin-fulfillment-operations.controller';
import { ListFulfillmentOperationsQueryDto } from '../interface/dtos/fulfillment-operations.dto';
import { toFulfillmentOperationsListResponse, toFulfillmentOperationsResponse } from '../interface/dtos/fulfillment-operations.response';
import { GetFulfillmentOperationsQuery, ListFulfillmentOperationsQuery, MAX_FULFILLMENT_OPERATIONS_PAGE_SIZE } from './queries/fulfillment-operations.queries';

const F1 = '11111111-1111-4111-8111-111111111111';
const O1 = '22222222-2222-4222-8222-222222222222';
const J1 = '33333333-3333-4333-8333-333333333333';
const KEYS = ['fulfillmentId', 'orderId', 'pharmacyId', 'branchId', 'status', 'deliveryJobId', 'hasDeliveryJobReference', 'acceptedAt', 'readyAt', 'createdAt'];
const view = (over: Partial<FulfillmentOperationsView> = {}): FulfillmentOperationsView => ({
  fulfillmentId: F1, orderId: O1, pharmacyId: 'ph-1', branchId: 'br-1', status: FulfillmentStatus.READY, deliveryJobId: J1, hasDeliveryJobReference: true,
  acceptedAt: new Date('2026-10-14T09:00:00Z'), readyAt: new Date('2026-10-14T10:00:00Z'), createdAt: new Date('2026-10-14T08:00:00Z'), ...over,
});
const row = (id: string, orderId: string, deliveryJobId: string | null) => ({
  id, orderId, pharmacyId: 'ph', branchId: 'br', status: 'READY', deliveryJobId, acceptedAt: null, readyAt: null, createdAt: new Date('2026-10-14T08:00:00Z'),
});

/** An array-transaction double: records each findMany/count and runs them with the given rows. */
function fakePrisma(rows: ReturnType<typeof row>[]) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let options: unknown;
  const prisma = {
    fulfillment: {
      findMany: (args: Record<string, unknown>) => (calls.push({ op: 'findMany', args }), Promise.resolve(rows)),
      count: (args: Record<string, unknown>) => (calls.push({ op: 'count', args }), Promise.resolve(rows.length)),
      findUnique: async (args: { where: { id: string } }) => (calls.push({ op: 'findUnique', args }), rows.find((r) => r.id === args.where.id) ?? null),
    },
    $transaction: async (ops: Array<Promise<unknown>>, o: unknown) => ((options = o), Promise.all(ops)),
  } as unknown as PrismaService;
  return { prisma, calls, options: () => options };
}

describe('Admin fulfillment operations (Work 46)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListFulfillmentOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('list', () => {
    it('an empty list is a valid page; paging defaults to 1/20 and clamps to 100; filters forwarded exactly', async () => {
      const seen: Array<{ f: FulfillmentOperationsFilter; page: number; size: number }> = [];
      const port: IFulfillmentOperationsReadPort = { listFulfillments: async (f, page, size) => (seen.push({ f, page, size }), { items: [], total: 0, page, size }), getFulfillment: async () => null };
      const q = new ListFulfillmentOperationsQuery(port);
      expect(toFulfillmentOperationsListResponse(await q.execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 3, size: 1000, status: FulfillmentStatus.READY, orderId: O1, hasDeliveryJobReference: false });
      await q.execute({ page: 0, size: -1 });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [3, MAX_FULFILLMENT_OPERATIONS_PAGE_SIZE], [1, 20]]);
      expect(seen[1].f).toMatchObject({ status: 'READY', orderId: O1, hasDeliveryJobReference: false });
    });

    it('request validation: real FulfillmentStatus values, UUID ids, ISO dates, raw-string boolean, bounded paging, unknown parameters refused', () => {
      expect(Object.values(FulfillmentStatus)).toEqual(['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED', 'DELIVERED', 'CANCELLED']);
      for (const status of Object.values(FulfillmentStatus)) expect(dtoErrors({ status })).toEqual([]);
      expect(dtoErrors({ status: 'EN_ROUTE' })).toEqual(['status']); // a delivery-job status, not a fulfillment one
      expect(dtoErrors({ orderId: O1, pharmacyId: F1, branchId: J1, createdFrom: '2026-10-01', readyTo: '2026-10-14T00:00:00Z', hasDeliveryJobReference: 'false' })).toEqual([]);
      expect(plainToInstance(ListFulfillmentOperationsQueryDto, { hasDeliveryJobReference: 'false' }, { enableImplicitConversion: true }).hasDeliveryJobReference).toBe('false');
      for (const [k, v] of [['orderId', 'ORD-1'], ['pharmacyId', 'ph-1'], ['branchId', '7'], ['createdFrom', 'yesterday'], ['readyFrom', 'soon'], ['hasDeliveryJobReference', 'TRUE'], ['hasDeliveryJobReference', 'yes'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['deliveryJobId', 'customerUserId', 'q', 'deliveryStatus']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('adapter: every filter is a fulfillments column; page and total share the where in one REPEATABLE READ transaction; newest first with id tiebreaker', async () => {
      const { prisma, calls, options } = fakePrisma([]);
      const d = (s: string) => new Date(s);
      await new PrismaFulfillmentOperationsReadAdapter(prisma).listFulfillments(
        { status: FulfillmentStatus.READY, orderId: O1, pharmacyId: 'p', branchId: 'b', hasDeliveryJobReference: true, createdFrom: d('2026-10-01T00:00:00Z'), createdTo: d('2026-10-15T00:00:00Z'), readyFrom: d('2026-10-02T00:00:00Z') },
        2, 10,
      );
      const where = { status: 'READY', orderId: O1, pharmacyId: 'p', branchId: 'b', deliveryJobId: { not: null }, createdAt: { gte: d('2026-10-01T00:00:00Z'), lt: d('2026-10-15T00:00:00Z') }, readyAt: { gte: d('2026-10-02T00:00:00Z') } };
      expect(calls[0].args).toMatchObject({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 10, take: 10 });
      expect(Object.keys(calls[0].args.select as object).sort()).toEqual(['acceptedAt', 'branchId', 'createdAt', 'deliveryJobId', 'id', 'orderId', 'pharmacyId', 'readyAt', 'status']);
      expect(calls[1]).toEqual({ op: 'count', args: { where } });
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls).toHaveLength(2); // no per-row query
    });

    it('false filters on deliveryJobId IS NULL; two fulfillments of one order stay two rows, each with its own reference flag', async () => {
      const { prisma, calls } = fakePrisma([row(F1, O1, J1), row(J1, O1, null)]);
      const page = await new PrismaFulfillmentOperationsReadAdapter(prisma).listFulfillments({ hasDeliveryJobReference: false }, 1, 20);
      expect(calls[0].args.where).toEqual({ deliveryJobId: null });
      expect(page.items.map((i) => [i.fulfillmentId, i.orderId, i.hasDeliveryJobReference, i.deliveryJobId])).toEqual([[F1, O1, true, J1], [J1, O1, false, null]]);
    });
  });

  describe('detail', () => {
    it('one fulfillment with its order id and recorded job id; unknown → 404', async () => {
      const port: IFulfillmentOperationsReadPort = { listFulfillments: async (_f, page, size) => ({ items: [], total: 0, page, size }), getFulfillment: async (id) => (id === F1 ? view() : null) };
      const res = toFulfillmentOperationsResponse(await new GetFulfillmentOperationsQuery(port).execute(F1));
      expect(Object.keys(res)).toEqual(KEYS);
      expect(res).toMatchObject({ fulfillmentId: F1, orderId: O1, deliveryJobId: J1, hasDeliveryJobReference: true, readyAt: '2026-10-14T10:00:00.000Z' });
      try {
        await new GetFulfillmentOperationsQuery(port).execute(O1);
        throw new Error('expected 404');
      } catch (e) {
        expect(e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e)).toBe('404 NOT_FOUND');
      }
    });

    it('a missing reference is reported as null/false and nothing else — no delivery status is derived, nothing implies Module 08 has no job', () => {
      const res = toFulfillmentOperationsResponse(view({ deliveryJobId: null, hasDeliveryJobReference: false }));
      expect([res.deliveryJobId, res.hasDeliveryJobReference]).toEqual([null, false]);
      for (const k of ['deliveryStatus', 'jobStatus', 'hasDeliveryJob', 'deliveryJobExists', 'driverProfileId', 'assignedAt']) expect(res).not.toHaveProperty(k);
      // The status is Module 06's fulfillment status, passed through as stored.
      expect(toFulfillmentOperationsResponse(view({ status: FulfillmentStatus.READY })).status).toBe('READY');
    });

    it('explicit allow-list: extra properties never reach the response', () => {
      const leaky = Object.assign(view(), { customerUserId: 'cust-secret', addressSnapshot: { line1: 'Bole' }, dropoffLat: 9.01, providerRef: 'TB-SECRET' });
      const res = toFulfillmentOperationsResponse(leaky);
      expect(Object.keys(res)).toEqual(KEYS);
      expect(JSON.stringify(res)).not.toMatch(/secret|SECRET|Bole|9\.01/);
    });

    it('adapter detail: one findUnique on the primary key, explicit select, hasDeliveryJobReference = deliveryJobId !== null', async () => {
      const { prisma, calls } = fakePrisma([row(F1, O1, null)]);
      const v = await new PrismaFulfillmentOperationsReadAdapter(prisma).getFulfillment(F1);
      expect(v).toMatchObject({ fulfillmentId: F1, deliveryJobId: null, hasDeliveryJobReference: false });
      expect(calls[0]).toMatchObject({ op: 'findUnique', args: { where: { id: F1 } } });
      expect(await new PrismaFulfillmentOperationsReadAdapter(prisma).getFulfillment(J1)).toBeNull();
    });
  });

  describe('authorization and read-only shape', () => {
    it('GET-only under admin/operations/fulfillments with order:read:any; the port has only reads', () => {
      expect(Reflect.getMetadata('path', AdminFulfillmentOperationsController)).toBe('admin/operations/fulfillments');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminFulfillmentOperationsController)).toEqual(['order:read:any']);
      const methods = Object.getOwnPropertyNames(AdminFulfillmentOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminFulfillmentOperationsController.prototype[m as 'search'])).toBe(0);
      expect(Object.getOwnPropertyNames(PrismaFulfillmentOperationsReadAdapter.prototype).filter((m) => m !== 'constructor')).toEqual(['listFulfillments', 'getFulfillment']);
    });

    it('order:read:any is ADMIN-only (SUPER_ADMIN by wildcard); pharmacy, driver and analytics grants do not reach it', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'order:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['order:read:org', 'order:read:own', 'delivery:read:own', 'delivery:read:any', 'analytics:read'], 'order:read:any')).toBe(false);
    });
  });
});
