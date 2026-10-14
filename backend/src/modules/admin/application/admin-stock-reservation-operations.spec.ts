import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  IStockReservationOperationsReadPort,
  ReservationStatus,
  StockReservationOperationsFilter,
  StockReservationOperationsView,
} from '../../pharmacy-inventory/application/ports/inbound/stock-reservation-operations-read.port';
import { isHeldPastExpiry, PrismaStockReservationOperationsReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-stock-reservation-operations-read.adapter';
import { AdminStockReservationOperationsController } from '../interface/controllers/admin-stock-reservation-operations.controller';
import { ListStockReservationOperationsQueryDto } from '../interface/dtos/stock-reservation-operations.dto';
import {
  toStockReservationOperationsDetailResponse,
  toStockReservationOperationsListResponse,
  toStockReservationOperationsResponse,
} from '../interface/dtos/stock-reservation-operations.response';
import { GetStockReservationOperationsQuery, ListStockReservationOperationsQuery, MAX_RESERVATION_PAGE_SIZE } from './queries/stock-reservation-operations.queries';

const NOW = new Date('2026-10-14T12:00:00Z');
const R1 = '11111111-1111-4111-8111-111111111111';
const L1 = '22222222-2222-4222-8222-222222222222';
const KEYS = ['reservationId', 'listingId', 'pharmacyId', 'branchId', 'catalogProductId', 'quantity', 'status', 'expiresAt', 'heldPastExpiry', 'dispatched', 'createdAt'];
const at = (ms: number) => new Date(NOW.getTime() + ms);
const row = (over: Record<string, unknown> = {}) => ({
  id: R1, listingId: L1, quantity: 3, status: 'HELD', expiresAt: at(60_000), createdAt: NOW,
  listing: { pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp' }, _count: { movements: 0 }, ...over,
});

function fakePrisma(rows: unknown[]) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let options: unknown;
  const prisma = {
    stockReservation: {
      findMany: (args: Record<string, unknown>) => (calls.push({ op: 'findMany', args }), Promise.resolve(rows)),
      count: (args: Record<string, unknown>) => (calls.push({ op: 'count', args }), Promise.resolve(rows.length)),
      findUnique: async (args: Record<string, unknown>) => (calls.push({ op: 'findUnique', args }), rows[0] ?? null),
    },
    $transaction: async (ops: Array<Promise<unknown>>, o: unknown) => ((options = o), Promise.all(ops)),
  } as unknown as PrismaService;
  return { prisma, calls, options: () => options };
}
const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'pharmacy-inventory', f), 'utf8');

describe('Admin inventory reservation visibility (Work 52)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListStockReservationOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('lifecycle as the writers record it', () => {
    it('statuses are Module 04’s; reserve writes HELD, confirm CONFIRMED, release RELEASED and the sweeper EXPIRED; dispatch leaves CONFIRMED', () => {
      expect(Object.values(ReservationStatus)).toEqual(['HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED']);
      expect(src('infrastructure/persistence/prisma-reservation.repository.ts')).toMatch(/status: ReservationStatus\.HELD/);
      expect(src('application/commands/confirm-reservation.command.ts')).toMatch(/updateStatus\(input\.reservationId, ReservationStatus\.CONFIRMED/);
      expect(src('infrastructure/scheduling/reservation-ttl.sweeper.ts')).toMatch(/updateStatus\(reservation\.id, ReservationStatus\.EXPIRED/);
      expect(src('application/commands/dispatch-stock.command.ts')).not.toMatch(/updateStatus\(/);
    });

    it('heldPastExpiry is the sweeper’s own predicate — HELD and expiresAt strictly before now', () => {
      expect(src('infrastructure/persistence/prisma-reservation.repository.ts')).toContain(`WHERE "status" = 'HELD' AND "expiresAt" < \${now}`);
      expect(isHeldPastExpiry(ReservationStatus.HELD, at(-1), NOW)).toBe(true);
      expect(isHeldPastExpiry(ReservationStatus.HELD, NOW, NOW)).toBe(false); // exactly at now: not yet past (strict <)
      expect(isHeldPastExpiry(ReservationStatus.HELD, at(1), NOW)).toBe(false);
      for (const s of [ReservationStatus.CONFIRMED, ReservationStatus.RELEASED, ReservationStatus.EXPIRED]) expect(isHeldPastExpiry(s, at(-86_400_000), NOW)).toBe(false);
    });

    it('dispatched follows Module 04’s dispatch lookup: a DISPATCH movement naming the reservation', () => {
      expect(src('infrastructure/persistence/prisma-reservation.repository.ts')).toMatch(/where: \{ type: StockMovementType\.DISPATCH, reservationId \}/);
    });
  });

  describe('Module 04 adapter', () => {
    it('one paged findMany and one count over the same where, in one REPEATABLE READ transaction; newest first; explicit select with a filtered DISPATCH sub-count', async () => {
      const { prisma, calls, options } = fakePrisma([]);
      await new PrismaStockReservationOperationsReadAdapter(prisma).listReservations({}, 2, 10, NOW);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls.map((c) => c.op)).toEqual(['findMany', 'count']);
      expect(calls[0].args).toMatchObject({ where: {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 10, take: 10 });
      const select = calls[0].args.select as Record<string, unknown>;
      expect(Object.keys(select).sort()).toEqual(['_count', 'createdAt', 'expiresAt', 'id', 'listing', 'listingId', 'quantity', 'status']);
      expect(select._count).toEqual({ select: { movements: { where: { type: 'DISPATCH' } } } });
      expect(JSON.stringify(select)).not.toMatch(/orderId|idempotencyKey|customer|reserved|sellable/);
    });

    it('filters: listing, owner ids through the listing, status, heldPastExpiry (AND / NOT at the same now), created window — page and total alike', async () => {
      for (const [flag, clause] of [[true, { AND: [{ status: 'HELD', expiresAt: { lt: NOW } }] }], [false, { NOT: [{ status: 'HELD', expiresAt: { lt: NOW } }] }]] as const) {
        const { prisma, calls } = fakePrisma([]);
        const f: StockReservationOperationsFilter = { listingId: L1, pharmacyId: 'ph', branchId: 'br', status: ReservationStatus.HELD, heldPastExpiry: flag, createdFrom: NOW, createdTo: NOW };
        await new PrismaStockReservationOperationsReadAdapter(prisma).listReservations(f, 1, 20, NOW);
        const where = { listingId: L1, listing: { pharmacyId: 'ph', branchId: 'br' }, status: 'HELD', ...clause, createdAt: { gte: NOW, lt: NOW } };
        expect(calls[0].args.where).toEqual(where);
        expect(calls[1]).toEqual({ op: 'count', args: { where } });
      }
    });

    it('maps each reservation once: its own quantity and stored status; flags at the response’s generatedAt', async () => {
      const { prisma } = fakePrisma([
        row({ status: 'HELD', expiresAt: at(-1) }),
        row({ id: 'r2', status: 'CONFIRMED', quantity: 5, _count: { movements: 2 } }), // two batch allocations, still one row
        row({ id: 'r3', status: 'RELEASED', expiresAt: at(-1) }),
      ]);
      const page = await new PrismaStockReservationOperationsReadAdapter(prisma).listReservations({}, 1, 20, NOW);
      expect(page.generatedAt).toBe(NOW);
      expect(page.items.map((i) => [i.reservationId, i.quantity, i.status, i.heldPastExpiry, i.dispatched])).toEqual([
        [R1, 3, 'HELD', true, false],
        ['r2', 5, 'CONFIRMED', false, true],
        ['r3', 3, 'RELEASED', false, false],
      ]);
      for (const k of ['reserved', 'listingReserved', 'sellable', 'orderId']) expect(page.items[0]).not.toHaveProperty(k);
    });

    it('detail: findUnique on the id; unknown → null', async () => {
      const { prisma, calls } = fakePrisma([row()]);
      expect(await new PrismaStockReservationOperationsReadAdapter(prisma).getReservation(R1, NOW)).toMatchObject({ generatedAt: NOW, reservation: { reservationId: R1 } });
      expect(calls[0].args.where).toEqual({ id: R1 });
      expect(await new PrismaStockReservationOperationsReadAdapter(fakePrisma([]).prisma).getReservation(R1, NOW)).toBeNull();
    });
  });

  describe('Module 16 surface', () => {
    const view = (over: Partial<StockReservationOperationsView> = {}): StockReservationOperationsView => ({
      reservationId: R1, listingId: L1, pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', quantity: 3, status: ReservationStatus.HELD, expiresAt: at(1),
      heldPastExpiry: false, dispatched: false, createdAt: NOW, ...over,
    });

    it('paging defaults/clamps; filters forwarded; empty list; detail 404', async () => {
      const seen: Array<{ f: StockReservationOperationsFilter; page: number; size: number }> = [];
      const port: IStockReservationOperationsReadPort = {
        listReservations: async (f, page, size) => (seen.push({ f, page, size }), { generatedAt: NOW, items: [], total: 0, page, size }),
        getReservation: async () => null,
      };
      const q = new ListStockReservationOperationsQuery(port);
      expect(toStockReservationOperationsListResponse(await q.execute({}))).toEqual({ generatedAt: NOW.toISOString(), items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 2, size: 500, status: ReservationStatus.CONFIRMED, heldPastExpiry: false });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [2, MAX_RESERVATION_PAGE_SIZE]]);
      expect(seen[1].f).toMatchObject({ status: 'CONFIRMED', heldPastExpiry: false });
      await expect(new GetStockReservationOperationsQuery(port).execute(R1)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('request validation: real statuses, UUID ids, raw-string boolean, ISO dates, bounded paging; no order/customer/key filter', () => {
      for (const status of Object.values(ReservationStatus)) expect(dtoErrors({ status })).toEqual([]);
      expect(dtoErrors({ listingId: L1, pharmacyId: L1, branchId: L1, heldPastExpiry: 'false', createdFrom: '2026-10-01' })).toEqual([]);
      for (const [k, v] of [['status', 'ACTIVE'], ['status', 'held'], ['listingId', 'L-1'], ['heldPastExpiry', 'yes'], ['heldPastExpiry', 'TRUE'], ['createdTo', 'soon'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['orderId', 'customerUserId', 'idempotencyKey', 'dispatched', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('explicit allow-lists: order id, idempotency key and customer never reach the response; detail adds only generatedAt', () => {
      const leaky = Object.assign(view(), { orderId: 'order-secret', idempotencyKey: 'key-secret', customerUserId: 'cust-secret' });
      expect(Object.keys(toStockReservationOperationsResponse(leaky))).toEqual(KEYS);
      const d = toStockReservationOperationsDetailResponse({ generatedAt: NOW, reservation: leaky });
      expect(Object.keys(d)).toEqual([...KEYS, 'generatedAt']);
      expect(JSON.stringify(d)).not.toMatch(/secret/);
    });

    it('pharmacy:read:any (Works 47–51), GET-only; owner, manager and inventory-staff grants do not reach it', () => {
      expect(Reflect.getMetadata('path', AdminStockReservationOperationsController)).toBe('admin/operations/inventory/reservations');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminStockReservationOperationsController)).toEqual(['pharmacy:read:any']);
      const methods = Object.getOwnPropertyNames(AdminStockReservationOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminStockReservationOperationsController.prototype[m as 'search'])).toBe(0);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['inventory:manage:org', 'pharmacy:manage:org', 'order:read:any'], 'pharmacy:read:any')).toBe(false);
    });
  });
});
