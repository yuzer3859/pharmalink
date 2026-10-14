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
  IStockMovementOperationsReadPort,
  StockMovementOperationsFilter,
  StockMovementOperationsView,
  StockMovementRefType,
  StockMovementType,
} from '../../pharmacy-inventory/application/ports/inbound/stock-movement-operations-read.port';
import { PrismaStockMovementOperationsReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-stock-movement-operations-read.adapter';
import { AdminStockMovementOperationsController } from '../interface/controllers/admin-stock-movement-operations.controller';
import { ListStockMovementOperationsQueryDto } from '../interface/dtos/stock-movement-operations.dto';
import { toStockMovementOperationsListResponse, toStockMovementOperationsResponse } from '../interface/dtos/stock-movement-operations.response';
import { GetStockMovementOperationsQuery, ListStockMovementOperationsQuery, MAX_STOCK_MOVEMENT_PAGE_SIZE } from './queries/stock-movement-operations.queries';

const NOW = new Date('2026-10-14T12:00:00Z');
const M1 = '11111111-1111-4111-8111-111111111111';
const L1 = '22222222-2222-4222-8222-222222222222';
const KEYS = ['movementId', 'listingId', 'pharmacyId', 'branchId', 'catalogProductId', 'batchId', 'type', 'quantityDelta', 'refType', 'createdAt'];
const row = (over: Record<string, unknown> = {}) => ({
  id: M1, listingId: L1, batchId: null, type: 'RESERVE', quantityDelta: -3, refType: 'ORDER', createdAt: NOW,
  listing: { pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp' }, ...over,
});

function fakePrisma(rows: unknown[]) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let options: unknown;
  const prisma = {
    stockMovement: {
      findMany: (args: Record<string, unknown>) => (calls.push({ op: 'findMany', args }), Promise.resolve(rows)),
      count: (args: Record<string, unknown>) => (calls.push({ op: 'count', args }), Promise.resolve(rows.length)),
      findUnique: async (args: Record<string, unknown>) => (calls.push({ op: 'findUnique', args }), rows[0] ?? null),
    },
    $transaction: async (ops: Array<Promise<unknown>>, o: unknown) => ((options = o), Promise.all(ops)),
  } as unknown as PrismaService;
  return { prisma, calls, options: () => options };
}

describe('Admin stock movement history (Work 50)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListStockMovementOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('movement semantics, as the writers record them', () => {
    it('the stored types are Module 04’s; the sign each writer uses is the sign reported (checked against the writers’ source)', () => {
      expect(Object.values(StockMovementType)).toEqual(['RECEIPT', 'RESERVE', 'RELEASE', 'DISPATCH', 'ADJUST', 'EXPIRE', 'RETURN']);
      const src = (f: string) => readFileSync(join(__dirname, '..', '..', 'pharmacy-inventory', f), 'utf8');
      expect(src('application/commands/reserve-stock.command.ts')).toMatch(/type: StockMovementType\.RESERVE,\s*quantityDelta: -input\.quantity/);
      expect(src('application/commands/release-reservation.command.ts')).toMatch(/type: StockMovementType\.RELEASE,\s*quantityDelta: reservation\.quantity/);
      expect(src('application/commands/dispatch-stock.command.ts')).toMatch(/type: StockMovementType\.DISPATCH,\s*quantityDelta: -allocation\.qty/);
      expect(src('application/commands/add-batch.command.ts')).toMatch(/type: StockMovementType\.RECEIPT,\s*quantityDelta: input\.quantity/);
      expect(src('application/commands/adjust-batch.command.ts')).toMatch(/type: StockMovementType\.ADJUST,\s*quantityDelta: input\.quantityDelta/);
    });

    it('the delta is passed through untouched — sign and units — and no balance, before or after, is produced', async () => {
      for (const [type, delta] of [['RECEIPT', 50], ['ADJUST', -2], ['RESERVE', -3], ['RELEASE', 3], ['DISPATCH', -1]] as const) {
        const { prisma } = fakePrisma([row({ type, quantityDelta: delta })]);
        const v = (await new PrismaStockMovementOperationsReadAdapter(prisma).getMovement(M1))!;
        expect([v.type, v.quantityDelta]).toEqual([type, delta]);
        const res = toStockMovementOperationsResponse(v);
        for (const k of ['balance', 'balanceAfter', 'before', 'after', 'onHand', 'sellable', 'reserved']) expect(res).not.toHaveProperty(k);
      }
    });
  });

  describe('Module 04 adapter', () => {
    it('one paged findMany and one count over the same where, in one REPEATABLE READ transaction; newest first with id tiebreaker; explicit select', async () => {
      const { prisma, calls, options } = fakePrisma([]);
      await new PrismaStockMovementOperationsReadAdapter(prisma).listMovements({}, 3, 10);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls.map((c) => c.op)).toEqual(['findMany', 'count']);
      expect(calls[0].args).toMatchObject({ where: {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 20, take: 10 });
      const select = calls[0].args.select as Record<string, unknown>;
      expect(Object.keys(select).sort()).toEqual(['batchId', 'createdAt', 'id', 'listing', 'listingId', 'quantityDelta', 'refType', 'type']);
      expect(select.listing).toEqual({ select: { pharmacyId: true, branchId: true, catalogProductId: true } });
      expect(JSON.stringify(select)).not.toMatch(/reason|refId|reservationId|actorUserId|price|batches|reservations/);
    });

    it('filters: stored columns, and pharmacy/branch through the movement’s one listing; page and total share the where', async () => {
      const { prisma, calls } = fakePrisma([]);
      const f: StockMovementOperationsFilter = { listingId: L1, batchId: M1, type: StockMovementType.DISPATCH, pharmacyId: 'ph', branchId: 'br', createdFrom: NOW, createdTo: NOW };
      await new PrismaStockMovementOperationsReadAdapter(prisma).listMovements(f, 1, 20);
      const where = { listingId: L1, batchId: M1, type: 'DISPATCH', listing: { pharmacyId: 'ph', branchId: 'br' }, createdAt: { gte: NOW, lt: NOW } };
      expect(calls[0].args.where).toEqual(where);
      expect(calls[1]).toEqual({ op: 'count', args: { where } });
    });

    it('maps each movement once with its listing’s owner ids; unknown id → null', async () => {
      const { prisma } = fakePrisma([row(), row({ id: 'm2', type: 'RELEASE', quantityDelta: 3, refType: 'SYSTEM' })]);
      const page = await new PrismaStockMovementOperationsReadAdapter(prisma).listMovements({}, 1, 20);
      expect(page.items.map((i) => [i.movementId, i.pharmacyId, i.branchId, i.catalogProductId, i.type, i.quantityDelta, i.refType])).toEqual([
        [M1, 'ph', 'br', 'cp', 'RESERVE', -3, 'ORDER'],
        ['m2', 'ph', 'br', 'cp', 'RELEASE', 3, 'SYSTEM'],
      ]);
      expect(await new PrismaStockMovementOperationsReadAdapter(fakePrisma([]).prisma).getMovement(M1)).toBeNull();
    });
  });

  describe('Module 16 surface', () => {
    const view = (over: Partial<StockMovementOperationsView> = {}): StockMovementOperationsView => ({
      movementId: M1, listingId: L1, pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', batchId: null, type: StockMovementType.RECEIPT,
      quantityDelta: 10, refType: StockMovementRefType.MANUAL, createdAt: NOW, ...over,
    });

    it('paging defaults/clamps; filters forwarded; empty list; detail 404', async () => {
      const seen: Array<{ f: StockMovementOperationsFilter; page: number; size: number }> = [];
      const port: IStockMovementOperationsReadPort = { listMovements: async (f, page, size) => (seen.push({ f, page, size }), { items: [], total: 0, page, size }), getMovement: async () => null };
      const q = new ListStockMovementOperationsQuery(port);
      expect(toStockMovementOperationsListResponse(await q.execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 2, size: 900, type: StockMovementType.ADJUST, listingId: L1 });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [2, MAX_STOCK_MOVEMENT_PAGE_SIZE]]);
      expect(seen[1].f).toMatchObject({ type: 'ADJUST', listingId: L1 });
      await expect(new GetStockMovementOperationsQuery(port).execute(M1)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('request validation: real StockMovementType values, UUID ids, ISO dates, bounded paging; no reason/reference/actor filter', () => {
      for (const type of Object.values(StockMovementType)) expect(dtoErrors({ type })).toEqual([]);
      expect(dtoErrors({ listingId: L1, pharmacyId: L1, branchId: L1, batchId: M1, createdFrom: '2026-10-01' })).toEqual([]);
      for (const [k, v] of [['type', 'SALE'], ['type', 'reserve'], ['listingId', 'L-1'], ['batchId', 'B-1'], ['pharmacyId', 'x'], ['createdFrom', 'yesterday'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['reason', 'refId', 'orderId', 'reservationId', 'actorUserId', 'refType', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('explicit allow-list: reason text, order/import id, reservation, actor and price never reach the response', () => {
      const leaky = Object.assign(view(), { reason: 'idempotencyKey=secret-key', refId: 'order-secret', reservationId: 'res-secret', actorUserId: 'user-secret', price: 4200 });
      const res = toStockMovementOperationsResponse(leaky);
      expect(Object.keys(res)).toEqual(KEYS);
      expect(JSON.stringify(res)).not.toMatch(/secret|4200/);
    });

    it('pharmacy:read:any (Works 47–49), GET-only; owner, manager and inventory-staff grants do not reach it', () => {
      expect(Reflect.getMetadata('path', AdminStockMovementOperationsController)).toBe('admin/operations/inventory/movements');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminStockMovementOperationsController)).toEqual(['pharmacy:read:any']);
      const methods = Object.getOwnPropertyNames(AdminStockMovementOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminStockMovementOperationsController.prototype[m as 'search'])).toBe(0);
      expect(Object.getOwnPropertyNames(PrismaStockMovementOperationsReadAdapter.prototype).filter((m) => m !== 'constructor')).toEqual(['listMovements', 'getMovement']);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['inventory:manage:org', 'pharmacy:manage:org'], 'pharmacy:read:any')).toBe(false);
    });
  });
});
