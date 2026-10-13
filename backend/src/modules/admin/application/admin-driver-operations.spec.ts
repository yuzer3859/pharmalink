import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  DeliveryJobStatus,
  DriverAvailability,
  DriverOperationsFilter,
  DriverOperationsSummary,
  IDriverOperationsReadPort,
} from '../../delivery/application/ports/inbound/driver-operations-read.port';
import { ACTIVE_JOB_STATUSES } from '../../delivery/domain/services/driver-availability-policy';
import { PrismaDriverOperationsReadAdapter } from '../../delivery/infrastructure/persistence/prisma-driver-operations-read.adapter';
import { AdminDriverOperationsController } from '../interface/controllers/admin-driver-operations.controller';
import { ListDriverOperationsQueryDto } from '../interface/dtos/driver-operations.dto';
import { toDriverOperationsListResponse, toDriverOperationsResponse } from '../interface/dtos/driver-operations.response';
import { GetDriverOperationsQuery, ListDriverOperationsQuery, MAX_DRIVER_OPERATIONS_PAGE_SIZE } from './queries/driver-operations.queries';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const STATUSES = Object.values(DeliveryJobStatus);
const KEYS = ['driverProfileId', 'availability', 'onShift', 'shiftStartedAt', 'lastOnlineAt', 'lastLocationAt', 'createdAt', 'updatedAt', 'totalJobs', 'activeJobCount', 'jobsByStatus'];
const zero = () => STATUSES.map((status) => ({ status, count: 0 }));
const summary = (over: Partial<DriverOperationsSummary> = {}): DriverOperationsSummary => ({
  driverProfileId: D1,
  availability: DriverAvailability.ONLINE,
  onShift: true,
  shiftStartedAt: new Date('2026-10-01T08:00:00Z'),
  lastOnlineAt: new Date('2026-10-01T08:00:00Z'),
  lastLocationAt: new Date('2026-10-01T09:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T09:00:00Z'),
  totalJobs: 0,
  activeJobCount: 0,
  jobsByStatus: zero(),
  ...over,
});
const profileRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, availability: 'ONLINE', shiftStartedAt: new Date('2026-10-01T08:00:00Z'), lastOnlineAt: null, lastLocationAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-09-01T00:00:00Z'), ...over,
});

/** A Prisma double whose interactive transaction runs the callback against itself. */
function fakePrisma(rows: unknown[], total: number, groups: unknown[]) {
  const calls: Record<string, unknown[]> = { findMany: [], count: [], findUnique: [], groupBy: [], options: [] };
  const client = {
    driverProfile: {
      findMany: async (a: unknown) => (calls.findMany.push(a), rows),
      count: async (a: unknown) => (calls.count.push(a), total),
      findUnique: async (a: { where: { id: string } }) => (calls.findUnique.push(a), (rows as Array<{ id: string }>).find((r) => r.id === a.where.id) ?? null),
    },
    deliveryJob: { groupBy: async (a: unknown) => (calls.groupBy.push(a), groups) },
  };
  const prisma = { ...client, $transaction: async (fn: (tx: unknown) => unknown, o: unknown) => (calls.options.push(o), fn(client)) } as unknown as PrismaService;
  return { prisma, calls };
}

describe('Admin driver operations (application)', () => {
  let filters: Array<{ f: DriverOperationsFilter; page: number; size: number }>;
  let driver: DriverOperationsSummary | null;
  let list: ListDriverOperationsQuery;
  let get: GetDriverOperationsQuery;

  beforeEach(() => {
    filters = [];
    driver = summary();
    const port: IDriverOperationsReadPort = {
      listDrivers: async (f, page, size) => (filters.push({ f, page, size }), { items: [summary()], total: 1, page, size }),
      getDriver: async () => driver,
    };
    list = new ListDriverOperationsQuery(port);
    get = new GetDriverOperationsQuery(port);
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
    validateSync(plainToInstance(ListDriverOperationsQueryDto, plain), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('list', () => {
    it('an empty list is a valid page', async () => {
      const empty: IDriverOperationsReadPort = { listDrivers: async (_f, page, size) => ({ items: [], total: 0, page, size }), getDriver: async () => null };
      expect(toDriverOperationsListResponse(await new ListDriverOperationsQuery(empty).execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
    });

    it('pages default to 1/20 and clamp to 100; filters are forwarded exactly', async () => {
      await list.execute({});
      await list.execute({ page: 2, size: 900, availability: DriverAvailability.BUSY, onShift: false });
      await list.execute({ page: -1, size: 0 });
      expect(filters.map(({ page, size }) => [page, size])).toEqual([[1, 20], [2, MAX_DRIVER_OPERATIONS_PAGE_SIZE], [1, 20]]);
      expect(filters[1].f).toEqual({ availability: 'BUSY', onShift: false });
    });

    it('request validation: Module 08 DriverAvailability values only; onShift as "true"/"false" (never coerced); bounded page/size; no personal-field filter', () => {
      expect(Object.values(DriverAvailability)).toEqual(['ONLINE', 'OFFLINE', 'BUSY']);
      for (const availability of Object.values(DriverAvailability)) expect(dtoErrors({ availability })).toEqual([]);
      expect(dtoErrors({ availability: 'ACTIVE' })).toEqual(['availability']);
      expect(dtoErrors({ availability: 'SUSPENDED' })).toEqual(['availability']); // an account state, not availability
      expect(plainToInstance(ListDriverOperationsQueryDto, { onShift: 'false' }, { enableImplicitConversion: true }).onShift).toBe('false');
      expect(dtoErrors({ onShift: 'yes' })).toEqual(['onShift']);
      expect(dtoErrors({ page: 0 })).toEqual(['page']);
      expect(dtoErrors({ size: 101 })).toEqual(['size']);
      for (const field of ['userId', 'phone', 'name', 'plateNumber', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });
  });

  describe('detail', () => {
    it('one profile, exactly the approved fields', async () => {
      const res = toDriverOperationsResponse(await get.execute(D1));
      expect(Object.keys(res)).toEqual(KEYS);
      expect(res).toMatchObject({ driverProfileId: D1, availability: 'ONLINE', onShift: true, shiftStartedAt: '2026-10-01T08:00:00.000Z', lastLocationAt: '2026-10-01T09:00:00.000Z' });
    });

    it('unknown profile → 404', async () => {
      driver = null;
      expect(await outcome(get.execute(D1))).toBe('404 NOT_FOUND');
    });

    it('explicit allow-list: extra properties on the port object never reach the response', async () => {
      driver = Object.assign(summary(), {
        userId: 'user-secret-id', plateNumber: 'AA-3-77777', vehicleType: 'MOTORBIKE', serviceArea: { lat: 9.01, lng: 38.76, radiusMeters: 5000 },
        lastLat: 9.0123, lastLng: 38.7654, phone: '+251911000000', name: 'Abebe', ratingAvg: 4.9,
      });
      const res = toDriverOperationsResponse(await get.execute(D1));
      expect(JSON.stringify(res)).not.toMatch(/user-secret|AA-3|MOTORBIKE|9\.01|38\.76|9\.0123|\+2519|Abebe|4\.9|userId|plate|vehicle|serviceArea|lat"|lng"|rating/);
    });
  });

  describe('Module 08 adapter — counts and workload', () => {
    it('counts jobs per stored Module 08 status (all 12, zero-filled, declaration order); total = Σ; active = Σ over ACTIVE_JOB_STATUSES', async () => {
      const { prisma } = fakePrisma([profileRow(D1)], 1, [
        { assignedDriverId: D1, status: 'ASSIGNED', _count: { _all: 1 } },
        { assignedDriverId: D1, status: 'EN_ROUTE', _count: { _all: 2 } },
        { assignedDriverId: D1, status: 'DELIVERED', _count: { _all: 5 } },
        { assignedDriverId: D1, status: 'COMPLETED', _count: { _all: 7 } },
        { assignedDriverId: D1, status: 'FAILED', _count: { _all: 1 } },
        { assignedDriverId: D1, status: 'CANCELLED', _count: { _all: 1 } },
      ]);
      const d = (await new PrismaDriverOperationsReadAdapter(prisma).getDriver(D1))!;
      expect(d.jobsByStatus.map((b) => b.status)).toEqual(STATUSES);
      expect(Object.fromEntries(d.jobsByStatus.filter((b) => b.count).map((b) => [b.status, b.count]))).toEqual({ ASSIGNED: 1, EN_ROUTE: 2, DELIVERED: 5, COMPLETED: 7, FAILED: 1, CANCELLED: 1 });
      expect(d.totalJobs).toBe(17);
      expect(d.activeJobCount).toBe(3);
    });

    it('the workload definition is Module 08’s BRULE-28 set — ASSIGNED through ARRIVED_DROPOFF, never CREATED, OFFERED, REASSIGNING or a terminal state', () => {
      expect([...ACTIVE_JOB_STATUSES]).toEqual(['ASSIGNED', 'ARRIVED_PICKUP', 'PICKED_UP', 'EN_ROUTE', 'ARRIVED_DROPOFF']);
    });

    it('a driver with no jobs: every count 0; availability and shift are the stored values, not inferred from the absence of jobs', async () => {
      const { prisma } = fakePrisma([profileRow(D1, { availability: 'BUSY' })], 1, []);
      const d = (await new PrismaDriverOperationsReadAdapter(prisma).getDriver(D1))!;
      expect(d).toMatchObject({ totalJobs: 0, activeJobCount: 0, jobsByStatus: zero(), availability: 'BUSY', onShift: true });
    });

    it('list: explicit column selection, newest first with id tiebreaker, filters as columns, ONE grouped count over the page’s ids, one REPEATABLE READ snapshot', async () => {
      const { prisma, calls } = fakePrisma([profileRow(D1), profileRow(D2, { shiftStartedAt: null, availability: 'OFFLINE' })], 7, [
        { assignedDriverId: D2, status: 'PICKED_UP', _count: { _all: 1 } },
        { assignedDriverId: D1, status: 'COMPLETED', _count: { _all: 2 } },
      ]);
      const page = await new PrismaDriverOperationsReadAdapter(prisma).listDrivers({ availability: DriverAvailability.ONLINE, onShift: true }, 3, 2);
      const find = calls.findMany[0] as { where: unknown; select: Record<string, unknown>; orderBy: unknown; skip: number; take: number };
      expect(find.where).toEqual({ availability: 'ONLINE', shiftStartedAt: { not: null } });
      expect(find.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect([find.skip, find.take]).toEqual([4, 2]);
      expect(Object.keys(find.select).sort()).toEqual(['availability', 'createdAt', 'id', 'lastLocationAt', 'lastOnlineAt', 'shiftStartedAt', 'updatedAt']);
      expect(calls.count).toEqual([{ where: find.where }]);
      expect(calls.groupBy).toHaveLength(1);
      expect(calls.groupBy[0]).toMatchObject({ by: ['assignedDriverId', 'status'], where: { assignedDriverId: { in: [D1, D2] } } });
      expect(calls.options).toEqual([{ isolationLevel: 'RepeatableRead' }]);
      expect(page.total).toBe(7);
      expect(page.items.map((i) => [i.driverProfileId, i.totalJobs, i.activeJobCount, i.onShift])).toEqual([[D1, 2, 0, true], [D2, 1, 1, false]]);
    });

    it('onShift=false filters on shiftStartedAt IS NULL; an empty page issues no job count', async () => {
      const { prisma, calls } = fakePrisma([], 0, []);
      await new PrismaDriverOperationsReadAdapter(prisma).listDrivers({ onShift: false }, 1, 20);
      expect((calls.findMany[0] as { where: unknown }).where).toEqual({ shiftStartedAt: null });
      expect(calls.groupBy).toEqual([]);
    });

    it('unknown id → null, no job count', async () => {
      const { prisma, calls } = fakePrisma([], 0, []);
      expect(await new PrismaDriverOperationsReadAdapter(prisma).getDriver(D1)).toBeNull();
      expect(calls.groupBy).toEqual([]);
    });
  });

  describe('authorization and read-only shape', () => {
    it('both routes are GET under admin/operations/drivers and take driver:read:any; there is no other route; the port only reads', () => {
      expect(Reflect.getMetadata('path', AdminDriverOperationsController)).toBe('admin/operations/drivers');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminDriverOperationsController)).toEqual(['driver:read:any']);
      const methods = Object.getOwnPropertyNames(AdminDriverOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) {
        expect({ m, method: Reflect.getMetadata('method', AdminDriverOperationsController.prototype[m as 'search']) }).toEqual({ m, method: 0 });
      }
      expect(Object.getOwnPropertyNames(PrismaDriverOperationsReadAdapter.prototype).filter((m) => m !== 'constructor')).toEqual(['listDrivers', 'getDriver']);
    });

    it('driver:read:any is ADMIN-only (SUPER_ADMIN by wildcard); it implies no driver or delivery action; delivery:read:own / delivery:read:any / analytics:read do not imply it', () => {
      expect(PERMISSIONS.find((p) => p.key === 'driver:read:any')).toEqual({ key: 'driver:read:any', resource: 'driver', action: 'read', scope: 'any' });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'driver:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      for (const action of ['driver:update:any', 'driver:suspend:any', 'driver:manage:any', 'delivery:update:any', 'delivery:read:any']) {
        expect({ action, ok: hasPermission(['driver:read:any'], action) }).toEqual({ action, ok: false });
      }
      expect(hasPermission(['analytics:read', 'delivery:read:own', 'delivery:read:any'], 'driver:read:any')).toBe(false);
    });
  });
});
