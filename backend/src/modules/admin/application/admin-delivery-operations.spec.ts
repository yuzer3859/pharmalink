import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  DeliveryJobStatus,
  DeliveryOperationsDetail,
  DeliveryOperationsFilter,
  DeliveryOperationsSummary,
  IDeliveryOperationsReadPort,
} from '../../delivery/application/ports/inbound/delivery-operations-read.port';
import { PrismaDeliveryOperationsReadAdapter } from '../../delivery/infrastructure/persistence/prisma-delivery-operations-read.adapter';
import { AdminDeliveryOperationsController } from '../interface/controllers/admin-delivery-operations.controller';
import { ListDeliveryOperationsQueryDto } from '../interface/dtos/delivery-operations.dto';
import { toDeliveryOperationsDetailResponse, toDeliveryOperationsListResponse } from '../interface/dtos/delivery-operations.response';
import { GetDeliveryOperationsQuery, ListDeliveryOperationsQuery, MAX_DELIVERY_OPERATIONS_PAGE_SIZE } from './queries/delivery-operations.queries';

const J1 = '11111111-1111-4111-8111-111111111111';
const O1 = '22222222-2222-4222-8222-222222222222';
const SUMMARY_KEYS = [
  'deliveryJobId', 'orderId', 'fulfillmentId', 'pharmacyId', 'branchId', 'status', 'driverProfileId',
  'isCod', 'isColdChain', 'etaAt', 'pickedUpAt', 'deliveredAt', 'createdAt', 'updatedAt',
];
const summary = (over: Partial<DeliveryOperationsSummary> = {}): DeliveryOperationsSummary => ({
  deliveryJobId: J1,
  orderId: O1,
  fulfillmentId: 'f-1',
  pharmacyId: 'ph-1',
  branchId: 'br-1',
  status: DeliveryJobStatus.EN_ROUTE,
  driverProfileId: 'drv-1',
  isCod: true,
  isColdChain: false,
  etaAt: new Date('2026-10-01T10:00:00Z'),
  pickedUpAt: new Date('2026-10-01T09:30:00Z'),
  deliveredAt: null,
  createdAt: new Date('2026-10-01T09:00:00Z'),
  updatedAt: new Date('2026-10-01T09:35:00Z'),
  ...over,
});
const none = { assignedAt: null, arrivedPickupAt: null, pickedUpAt: null, enRouteAt: null, arrivedDropoffAt: null, deliveredAt: null, completedAt: null, failedAt: null, cancelledAt: null };
const detail = (over: Partial<DeliveryOperationsDetail> = {}): DeliveryOperationsDetail => ({
  ...summary(),
  timeline: { ...none, assignedAt: new Date('2026-10-01T09:05:00Z'), pickedUpAt: new Date('2026-10-01T09:30:00Z'), enRouteAt: new Date('2026-10-01T09:31:00Z') },
  cod: null,
  ...over,
});

describe('Admin delivery operations (application)', () => {
  let filters: Array<{ f: DeliveryOperationsFilter; page: number; size: number }>;
  let job: DeliveryOperationsDetail | null;
  let list: ListDeliveryOperationsQuery;
  let get: GetDeliveryOperationsQuery;

  beforeEach(() => {
    filters = [];
    job = detail();
    const port: IDeliveryOperationsReadPort = {
      listJobs: async (f, page, size) => (filters.push({ f, page, size }), { items: [summary()], total: 1, page, size }),
      getJob: async () => job,
    };
    list = new ListDeliveryOperationsQuery(port);
    get = new GetDeliveryOperationsQuery(port);
  });

  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListDeliveryOperationsQueryDto, plain), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('list', () => {
    it('an empty list is a valid page', async () => {
      const empty: IDeliveryOperationsReadPort = { listJobs: async (_f, page, size) => ({ items: [], total: 0, page, size }), getJob: async () => null };
      expect(toDeliveryOperationsListResponse(await new ListDeliveryOperationsQuery(empty).execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
    });

    it('pages default to 1/20 and clamp to 100; filters are forwarded exactly', async () => {
      await list.execute({});
      await list.execute({ page: 3, size: 500, status: DeliveryJobStatus.FAILED, orderId: O1, isCod: false, createdTo: new Date('2026-10-02T00:00:00Z') });
      await list.execute({ page: 0, size: -4 });
      expect(filters.map(({ page, size }) => [page, size])).toEqual([[1, 20], [3, MAX_DELIVERY_OPERATIONS_PAGE_SIZE], [1, 20]]);
      expect(filters[1].f).toEqual({ status: 'FAILED', orderId: O1, isCod: false, createdFrom: undefined, createdTo: new Date('2026-10-02T00:00:00Z') });
    });

    it('a summary carries exactly the approved fields', async () => {
      const res = toDeliveryOperationsListResponse(await list.execute({}));
      expect(Object.keys(res.items[0])).toEqual(SUMMARY_KEYS);
    });

    it('request validation: Module 08 DeliveryJobStatus values only; orderId a UUID; isCod as "true"/"false" (never coerced); bounded page/size', () => {
      for (const status of Object.values(DeliveryJobStatus)) expect(dtoErrors({ status })).toEqual([]);
      expect(Object.values(DeliveryJobStatus)).toEqual([
        'CREATED', 'OFFERED', 'ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF', 'DELIVERED', 'COMPLETED', 'REASSIGNING', 'CANCELLED', 'FAILED',
      ]);
      expect(dtoErrors({ status: 'DISPATCHED' })).toEqual(['status']); // an order status, not a delivery one
      expect(dtoErrors({ status: 'READY' })).toEqual(['status']); // a fulfillment status
      expect(dtoErrors({ orderId: O1 })).toEqual([]);
      expect(dtoErrors({ orderId: 'ORD-1001' })).toEqual(['orderId']);
      expect(plainToInstance(ListDeliveryOperationsQueryDto, { isCod: 'false' }, { enableImplicitConversion: true }).isCod).toBe('false');
      expect(dtoErrors({ isCod: 'yes' })).toEqual(['isCod']);
      expect(dtoErrors({ page: 0 })).toEqual(['page']);
      expect(dtoErrors({ size: 101 })).toEqual(['size']);
      expect(dtoErrors({ createdFrom: 'yesterday' })).toEqual(['createdFrom']);
      for (const field of ['driverId', 'address', 'q', 'customerUserId']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });
  });

  describe('detail', () => {
    it('one job with its Module 08 timeline and COD collection state', async () => {
      job = detail({
        cod: {
          collectionId: 'col-1', status: CodCollectionStatus.REMITTED, method: CodCollectionMethod.CASH, expectedAmount: 12_500, collectedAmount: 12_500,
          currency: 'ETB', collectedAt: new Date('2026-10-01T10:05:00Z'), remittedAt: new Date('2026-10-02T08:00:00Z'), reconciledAt: null,
        },
      });
      const res = toDeliveryOperationsDetailResponse(await get.execute(J1));
      expect(res.timeline).toEqual({ ...none, assignedAt: '2026-10-01T09:05:00.000Z', pickedUpAt: '2026-10-01T09:30:00.000Z', enRouteAt: '2026-10-01T09:31:00.000Z' });
      expect(res.cod).toEqual({
        collectionId: 'col-1', status: 'REMITTED', method: 'CASH', expectedAmount: 12_500, collectedAmount: 12_500, currency: 'ETB',
        collectedAt: '2026-10-01T10:05:00.000Z', remittedAt: '2026-10-02T08:00:00.000Z', reconciledAt: null,
      });
      expect(Object.keys(res)).toEqual([...SUMMARY_KEYS, 'timeline', 'cod']);
    });

    it('the status is Module 08’s own stored value, passed through — never derived from order, fulfillment, payment or COD state', async () => {
      // A COD collection that is RECONCILED says nothing about the job; the job's own status wins.
      job = detail({
        status: DeliveryJobStatus.FAILED,
        cod: { collectionId: 'c', status: CodCollectionStatus.RECONCILED, method: CodCollectionMethod.CASH, expectedAmount: 1, collectedAmount: 1, currency: 'ETB', collectedAt: new Date(), remittedAt: null, reconciledAt: null },
      });
      const res = toDeliveryOperationsDetailResponse(await get.execute(J1));
      expect(res.status).toBe('FAILED');
      for (const k of ['orderStatus', 'fulfillmentStatus', 'paymentStatus', 'deliveryStatus', 'lifecycle']) expect(res).not.toHaveProperty(k);
    });

    it('explicit allow-list: extra properties on the port object never reach the response', async () => {
      job = Object.assign(detail(), {
        dropoffAddress: 'Bole Road, House 12', dropoffLat: 9.01, dropoffLng: 38.76, items: [{ name: 'secret med' }],
        driverName: 'Abebe', driverPhone: '+251911000000', proofPhoto: 'pod.jpg', reason: 'customer not home',
      });
      const res = toDeliveryOperationsDetailResponse(await get.execute(J1));
      expect(JSON.stringify(res)).not.toMatch(/Bole|38\.76|9\.01|secret med|Abebe|\+2519|pod\.jpg|not home|address|lat|lng|phone|proof|reason/i);
    });

    it('unknown job → 404', async () => {
      job = null;
      expect(await outcome(get.execute(J1))).toBe('404 NOT_FOUND');
    });
  });

  describe('Module 08 adapter', () => {
    it('lists with an explicit column selection (no address, coordinate or manifest), newest first with an id tiebreaker, page and total in one transaction', async () => {
      const calls: Array<{ op: string; args: unknown }> = [];
      const prisma = {
        deliveryJob: {
          findMany: (args: unknown) => (calls.push({ op: 'findMany', args }), 'rows'),
          count: (args: unknown) => (calls.push({ op: 'count', args }), 'total'),
        },
        $transaction: async (ops: unknown[]) => (expect(ops).toEqual(['rows', 'total']), [[], 0]),
      } as unknown as PrismaService;
      await new PrismaDeliveryOperationsReadAdapter(prisma).listJobs({ status: DeliveryJobStatus.ASSIGNED, orderId: O1, isCod: false }, 2, 10);
      const find = calls[0].args as { where: unknown; select: Record<string, unknown>; orderBy: unknown; skip: number; take: number };
      expect(find.where).toEqual({ status: 'ASSIGNED', orderId: O1, isCod: false });
      expect(find.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect([find.skip, find.take]).toEqual([10, 10]);
      expect(Object.keys(find.select).sort()).toEqual([
        'assignedDriverId', 'branchId', 'createdAt', 'deliveredAt', 'etaAt', 'fulfillmentId', 'id', 'isCod', 'isColdChain', 'orderId', 'pharmacyId', 'pickedUpAt', 'status', 'updatedAt',
      ]);
      expect(JSON.stringify(find.select)).not.toMatch(/Address|Lat|Lng|items|driver"|codAmount/);
      expect(calls[1]).toEqual({ op: 'count', args: { where: { status: 'ASSIGNED', orderId: O1, isCod: false } } });
    });

    it('detail reads job, transitions (status and time only) and COD collection in one REPEATABLE READ snapshot; timeline from Module 08’s own rule', async () => {
      const calls: Record<string, unknown> = {};
      const row = { ...summaryRow(), status: 'DELIVERED', pickedUpAt: new Date('2026-10-01T09:30:00Z'), deliveredAt: new Date('2026-10-01T09:50:00Z') };
      const history = [
        { toStatus: 'ASSIGNED', createdAt: new Date('2026-10-01T09:05:00Z') },
        { toStatus: 'REASSIGNING', createdAt: new Date('2026-10-01T09:10:00Z') },
        { toStatus: 'ASSIGNED', createdAt: new Date('2026-10-01T09:12:00Z') },
      ];
      let options: unknown;
      const prisma = {
        deliveryJob: { findUnique: (a: unknown) => ((calls.job = a), 'job') },
        deliveryStatusHistory: { findMany: (a: unknown) => ((calls.history = a), 'history') },
        codCollection: { findUnique: (a: unknown) => ((calls.cod = a), 'cod') },
        $transaction: async (ops: unknown[], o: unknown) => (expect(ops).toEqual(['job', 'history', 'cod']), (options = o), [row, history, null]),
      } as unknown as PrismaService;
      const res = await new PrismaDeliveryOperationsReadAdapter(prisma).getJob(J1);
      expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls.history).toEqual({ where: { jobId: J1 }, select: { toStatus: true, createdAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(JSON.stringify(calls.cod)).not.toMatch(/providerReference|settlementRef|driverId|disputes|corrections/);
      expect(res?.status).toBe('DELIVERED');
      // First entry into ASSIGNED, not the reassignment's — `deliveryTimelineOf`'s rule.
      expect(res?.timeline).toEqual({ ...none, assignedAt: new Date('2026-10-01T09:05:00Z'), pickedUpAt: row.pickedUpAt, deliveredAt: row.deliveredAt });
      expect(res?.cod).toBeNull();
    });

    it('detail of an unknown id → null', async () => {
      const prisma = {
        deliveryJob: { findUnique: () => 'job' },
        deliveryStatusHistory: { findMany: () => 'history' },
        codCollection: { findUnique: () => 'cod' },
        $transaction: async () => [null, [], null],
      } as unknown as PrismaService;
      expect(await new PrismaDeliveryOperationsReadAdapter(prisma).getJob(J1)).toBeNull();
    });
  });

  describe('authorization and read-only shape', () => {
    it('both routes are GET under admin/operations/deliveries and take delivery:read:any; there is no other route', () => {
      expect(Reflect.getMetadata('path', AdminDeliveryOperationsController)).toBe('admin/operations/deliveries');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDeliveryOperationsController)).toEqual(['delivery:read:any']);
      const methods = Object.getOwnPropertyNames(AdminDeliveryOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) {
        expect({ m, method: Reflect.getMetadata('method', AdminDeliveryOperationsController.prototype[m as 'search']) }).toEqual({ m, method: 0 });
      }
    });

    it('the read port exposes only listJobs and getJob', () => {
      const methods = Object.getOwnPropertyNames(PrismaDeliveryOperationsReadAdapter.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['listJobs', 'getJob']);
    });

    it('delivery:read:any is ADMIN-only (SUPER_ADMIN by wildcard); it implies no delivery action; own-level and analytics grants do not imply it', () => {
      expect(PERMISSIONS.find((p) => p.key === 'delivery:read:any')).toEqual({ key: 'delivery:read:any', resource: 'delivery', action: 'read', scope: 'any' });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'delivery:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      for (const action of ['delivery:update:any', 'delivery:accept:any', 'delivery:assign:any', 'cod:reconcile:any', 'order:read:any']) {
        expect({ action, ok: hasPermission(['delivery:read:any'], action) }).toEqual({ action, ok: false });
      }
      expect(hasPermission(['analytics:read', 'delivery:read:own', 'order:read:any'], 'delivery:read:any')).toBe(false);
    });
  });
});

function summaryRow() {
  return {
    id: J1, orderId: O1, fulfillmentId: 'f-1', pharmacyId: 'ph-1', branchId: 'br-1', status: 'ASSIGNED', assignedDriverId: 'drv-1',
    isCod: false, isColdChain: false, etaAt: null, pickedUpAt: null, deliveredAt: null,
    createdAt: new Date('2026-10-01T09:00:00Z'), updatedAt: new Date('2026-10-01T09:00:00Z'),
  };
}
