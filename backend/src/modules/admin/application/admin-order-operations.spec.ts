import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  FulfillmentStatus,
  IOrderOperationsReadPort,
  OrderOperationsDetail,
  OrderOperationsFilter,
  OrderOperationsSummary,
  OrderStatus,
} from '../../orders/application/ports/inbound/order-operations-read.port';
import { PrismaOrderOperationsReadAdapter } from '../../orders/infrastructure/persistence/prisma-order-operations-read.adapter';
import { IFinanceOversightPort, PaymentMethod, PaymentStatus } from '../../payment/application/ports/inbound/finance-oversight.port';
import { AdminOrderOperationsController } from '../interface/controllers/admin-order-operations.controller';
import { ListOrderOperationsQueryDto } from '../interface/dtos/order-operations.dto';
import { toOrderOperationsDetailResponse, toOrderOperationsListResponse } from '../interface/dtos/order-operations.response';
import { GetOrderOperationsQuery, ListOrderOperationsQuery, MAX_ORDER_OPERATIONS_PAGE_SIZE } from './queries/order-operations.queries';

const O1 = '11111111-1111-4111-8111-111111111111';
const summary = (over: Partial<OrderOperationsSummary> = {}): OrderOperationsSummary => ({
  orderId: O1,
  orderNumber: 'ORD-1001',
  status: OrderStatus.PAID,
  isCod: false,
  grandTotal: 12_500,
  currency: 'ETB',
  lineCount: 2,
  fulfillmentCount: 1,
  placedAt: new Date('2026-10-01T09:00:00Z'),
  createdAt: new Date('2026-10-01T08:59:00Z'),
  updatedAt: new Date('2026-10-01T09:05:00Z'),
  ...over,
});
const detail = (over: Partial<OrderOperationsDetail> = {}): OrderOperationsDetail => ({
  ...summary(),
  subtotal: 11_000,
  deliveryFee: 1_000,
  platformFee: 500,
  discountTotal: 0,
  completedAt: null,
  cancelledAt: null,
  paymentId: 'pay-1',
  fulfillments: [
    { fulfillmentId: 'f-1', pharmacyId: 'ph-1', branchId: 'br-1', status: FulfillmentStatus.ACCEPTED, deliveryJobId: null, acceptedAt: new Date('2026-10-01T09:10:00Z'), readyAt: null, createdAt: new Date('2026-10-01T09:00:00Z') },
  ],
  ...over,
});

describe('Admin order operations (application)', () => {
  let filters: Array<{ f: OrderOperationsFilter; page: number; size: number }>;
  let order: OrderOperationsDetail | null;
  let paymentCalls: string[];
  let paymentResult: unknown;
  let list: ListOrderOperationsQuery;
  let get: GetOrderOperationsQuery;

  beforeEach(() => {
    filters = [];
    order = detail();
    paymentCalls = [];
    paymentResult = {
      payment: {
        paymentId: 'pay-1', orderId: O1, customerUserId: 'customer-secret', amount: 12_500, currency: 'ETB', method: PaymentMethod.TELEBIRR, status: PaymentStatus.CAPTURED,
        provider: 'telebirr', providerRef: 'TB-SECRET-REF', originalAmount: null, originalCurrency: null, fxRate: null, fxSource: null, authorizedAt: null, capturedAt: null,
        failureReason: 'gateway said something', createdAt: new Date('2026-10-01T09:00:00Z'), updatedAt: new Date('2026-10-01T09:02:00Z'),
      },
      refunds: { refunds: [], remainingRefundable: 12_500 },
    };
    const orders: IOrderOperationsReadPort = {
      listOrders: async (f, page, size) => (filters.push({ f, page, size }), { items: [{ ...summary(), hasDeliveryJobReference: false, unreferencedFulfillmentCount: 1 }], total: 1, page, size }),
      getOrder: async () => order,
    };
    const finance = { getPayment: async (id: string) => (paymentCalls.push(id), paymentResult) } as unknown as IFinanceOversightPort;
    list = new ListOrderOperationsQuery(orders);
    get = new GetOrderOperationsQuery(orders, finance);
  });

  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };
  const dtoErrors = (plain: object) => validateSync(plainToInstance(ListOrderOperationsQueryDto, plain), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('list', () => {
    it('an empty list is a valid page', async () => {
      const empty: IOrderOperationsReadPort = { listOrders: async (_f, page, size) => ({ items: [], total: 0, page, size }), getOrder: async () => null };
      expect(toOrderOperationsListResponse(await new ListOrderOperationsQuery(empty).execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
    });

    it('pages default to 1/20 and clamp to 100; filters are forwarded exactly', async () => {
      await list.execute({});
      await list.execute({ page: 3, size: 500, status: OrderStatus.CANCELLED, isCod: false, orderNumber: 'ORD-9', createdFrom: new Date('2026-10-01T00:00:00Z') });
      await list.execute({ page: 0, size: -4 });
      expect(filters.map(({ page, size }) => [page, size])).toEqual([[1, 20], [3, MAX_ORDER_OPERATIONS_PAGE_SIZE], [1, 20]]);
      expect(filters[1].f).toEqual({ status: 'CANCELLED', isCod: false, orderNumber: 'ORD-9', createdFrom: new Date('2026-10-01T00:00:00Z'), createdTo: undefined });
    });

    it('a summary carries exactly the approved fields', async () => {
      const res = toOrderOperationsListResponse(await list.execute({}));
      // Work 43 appends `hasDeliveryJobReference`, Work 44 `unreferencedFulfillmentCount`, to list rows only.
      expect(Object.keys(res.items[0])).toEqual(['orderId', 'orderNumber', 'status', 'isCod', 'grandTotal', 'currency', 'lineCount', 'fulfillmentCount', 'placedAt', 'createdAt', 'updatedAt', 'hasDeliveryJobReference', 'unreferencedFulfillmentCount']);
    });

    it('request validation: real OrderStatus values only; isCod as "true"/"false" (never coerced); bounded page/size; exact order-number shape', () => {
      for (const status of Object.values(OrderStatus)) expect(dtoErrors({ status })).toEqual([]);
      expect(Object.values(OrderStatus)).toEqual(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'READY', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']);
      expect(dtoErrors({ status: 'SHIPPED' })).toEqual(['status']);
      expect(plainToInstance(ListOrderOperationsQueryDto, { isCod: 'false' }, { enableImplicitConversion: true }).isCod).toBe('false');
      expect(dtoErrors({ isCod: 'yes' })).toEqual(['isCod']);
      expect(dtoErrors({ page: 0 })).toEqual(['page']);
      expect(dtoErrors({ size: 101 })).toEqual(['size']);
      expect(dtoErrors({ orderNumber: "ORD-1' OR 1=1" })).toEqual(['orderNumber']);
      expect(dtoErrors({ createdFrom: 'yesterday' })).toEqual(['createdFrom']);
      expect(dtoErrors({ customerUserId: O1 })).toEqual(['customerUserId']); // no customer filter exists
    });
  });

  describe('detail', () => {
    it('one order with its fulfillments and its payment’s status — the payment reduced to four fields', async () => {
      const res = toOrderOperationsDetailResponse(await get.execute(O1));
      expect(paymentCalls).toEqual(['pay-1']);
      expect(res.payment).toEqual({ paymentId: 'pay-1', status: 'CAPTURED', method: 'TELEBIRR', updatedAt: '2026-10-01T09:02:00.000Z' });
      expect(res.fulfillments).toEqual([
        { fulfillmentId: 'f-1', pharmacyId: 'ph-1', branchId: 'br-1', status: 'ACCEPTED', deliveryJobId: null, acceptedAt: '2026-10-01T09:10:00.000Z', readyAt: null, createdAt: '2026-10-01T09:00:00.000Z' },
      ]);
      expect(JSON.stringify(res)).not.toMatch(/customer-secret|TB-SECRET-REF|gateway said|providerRef|failureReason|customerUserId|refund/);
    });

    it('no payment linked → payment null, Module 07 not called; a link Module 07 does not know → null, nothing invented', async () => {
      order = detail({ paymentId: null });
      expect((await get.execute(O1)).payment).toBeNull();
      expect(paymentCalls).toEqual([]);
      order = detail();
      paymentResult = null;
      expect((await get.execute(O1)).payment).toBeNull();
    });

    it('no fabricated cross-module status: no delivery-job status, no derived lifecycle — only Module 06’s and Module 07’s own values', async () => {
      const res = toOrderOperationsDetailResponse(await get.execute(O1));
      expect(Object.keys(res.fulfillments[0])).not.toContain('deliveryStatus');
      expect(res).not.toHaveProperty('lifecycle');
      expect(res).not.toHaveProperty('deliveryStatus');
      expect(Object.keys(res)).toEqual([
        'orderId', 'orderNumber', 'status', 'isCod', 'grandTotal', 'currency', 'lineCount', 'fulfillmentCount', 'placedAt', 'createdAt', 'updatedAt',
        'subtotal', 'deliveryFee', 'platformFee', 'discountTotal', 'completedAt', 'cancelledAt', 'fulfillments', 'payment',
      ]);
    });

    it('unknown order → 404, Module 07 not called', async () => {
      order = null;
      expect(await outcome(get.execute(O1))).toBe('404 NOT_FOUND');
      expect(paymentCalls).toEqual([]);
    });
  });

  describe('Module 06 adapter', () => {
    it('lists with an explicit column selection (no customer, beneficiary, address or note), newest first with an id tiebreaker, page and total in one transaction', async () => {
      const calls: Array<{ op: string; args: unknown }> = [];
      // Page and total are read through the transaction client only (Work 43 made it an interactive
      // REPEATABLE READ transaction); the outer client is never queried directly.
      const tx = {
        order: {
          findMany: async (args: unknown) => (calls.push({ op: 'findMany', args }), []),
          count: async (args: unknown) => (calls.push({ op: 'count', args }), 0),
        },
      };
      const prisma = {
        order: { findMany: () => { throw new Error('read outside the transaction'); }, count: () => { throw new Error('read outside the transaction'); } },
        $transaction: async (fn: (t: unknown) => unknown, o: unknown) => (expect(o).toEqual({ isolationLevel: 'RepeatableRead' }), fn(tx)),
      } as unknown as PrismaService;
      await new PrismaOrderOperationsReadAdapter(prisma).listOrders({ status: OrderStatus.PAID, isCod: false }, 2, 10);
      const find = calls[0].args as { where: unknown; select: Record<string, unknown>; orderBy: unknown; skip: number; take: number };
      expect(find.where).toEqual({ status: 'PAID', isCod: false });
      expect(find.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect([find.skip, find.take]).toEqual([10, 10]);
      expect(Object.keys(find.select).sort()).toEqual(['_count', 'createdAt', 'currency', 'grandTotal', 'id', 'isCod', 'orderNumber', 'placedAt', 'status', 'updatedAt']);
      expect(JSON.stringify(find.select)).not.toMatch(/customerUserId|beneficiary|address|cancelReason|idempotencyKey|deliverySlot/);
      expect(calls[1]).toEqual({ op: 'count', args: { where: { status: 'PAID', isCod: false } } });
    });
  });

  describe('authorization and read-only shape', () => {
    it('both routes are GET under admin/operations/orders and take order:read:any; there is no other route', () => {
      expect(Reflect.getMetadata('path', AdminOrderOperationsController)).toBe('admin/operations/orders');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminOrderOperationsController)).toEqual(['order:read:any']);
      const methods = Object.getOwnPropertyNames(AdminOrderOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect({ m, method: Reflect.getMetadata('method', AdminOrderOperationsController.prototype[m as 'search']) }).toEqual({ m, method: 0 });
    });

    it('order:read:any is ADMIN-only (SUPER_ADMIN by wildcard); it implies no order, payment or delivery action; analytics:read does not imply it', () => {
      expect(PERMISSIONS.find((p) => p.key === 'order:read:any')).toEqual({ key: 'order:read:any', resource: 'order', action: 'read', scope: 'any' });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'order:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      for (const action of ['order:fulfill:any', 'order:cancel:any', 'payment:capture:any', 'payment:void:any', 'delivery:update:any', 'finance:refund:any']) {
        expect({ action, ok: hasPermission(['order:read:any'], action) }).toEqual({ action, ok: false });
      }
      expect(hasPermission(['analytics:read', 'order:read:own', 'order:read:org'], 'order:read:any')).toBe(false);
    });
  });
});
