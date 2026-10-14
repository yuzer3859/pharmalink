import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  IStockBatchOperationsReadPort,
  StockBatchOperationsFilter,
  StockBatchOperationsView,
} from '../../pharmacy-inventory/application/ports/inbound/stock-batch-operations-read.port';
import { SellableStockCalculator } from '../../pharmacy-inventory/domain/services/sellable-stock.calculator';
import { isBatchExpired, PrismaStockBatchOperationsReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-stock-batch-operations-read.adapter';
import { AdminStockBatchOperationsController } from '../interface/controllers/admin-stock-batch-operations.controller';
import { ListStockBatchOperationsQueryDto } from '../interface/dtos/stock-batch-operations.dto';
import {
  toStockBatchOperationsDetailResponse,
  toStockBatchOperationsListResponse,
  toStockBatchOperationsResponse,
} from '../interface/dtos/stock-batch-operations.response';
import { GetStockBatchOperationsQuery, ListStockBatchOperationsQuery, MAX_STOCK_BATCH_PAGE_SIZE } from './queries/stock-batch-operations.queries';

const NOW = new Date('2026-10-14T12:00:00Z');
const B1 = '11111111-1111-4111-8111-111111111111';
const L1 = '22222222-2222-4222-8222-222222222222';
const KEYS = ['batchId', 'listingId', 'pharmacyId', 'branchId', 'catalogProductId', 'quantity', 'expiryDate', 'isExpired', 'receivedAt', 'createdAt'];
const at = (ms: number) => new Date(NOW.getTime() + ms);
const row = (over: Record<string, unknown> = {}) => ({
  id: B1, listingId: L1, quantity: 7, expiryDate: at(1), receivedAt: null, createdAt: NOW, listing: { pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp' }, ...over,
});

function fakePrisma(rows: unknown[]) {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  let options: unknown;
  const prisma = {
    stockBatch: {
      findMany: (args: Record<string, unknown>) => (calls.push({ op: 'findMany', args }), Promise.resolve(rows)),
      count: (args: Record<string, unknown>) => (calls.push({ op: 'count', args }), Promise.resolve(rows.length)),
      findFirst: async (args: Record<string, unknown>) => (calls.push({ op: 'findFirst', args }), rows[0] ?? null),
    },
    $transaction: async (ops: Array<Promise<unknown>>, o: unknown) => ((options = o), Promise.all(ops)),
  } as unknown as PrismaService;
  return { prisma, calls, options: () => options };
}

describe('Admin stock batch visibility (Work 51)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListStockBatchOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('expiry rule — SellableStockCalculator’s, boundary included', () => {
    it('isBatchExpired is exactly "does not count toward sellable stock": before, at and after now', () => {
      for (const ms of [-86_400_000, -1, 0, 1, 86_400_000]) {
        const expiryDate = at(ms);
        const counts = SellableStockCalculator.computeSellable([{ quantity: 1, expiryDate }], 0, NOW) === 1;
        expect({ ms, expired: isBatchExpired(expiryDate, NOW) }).toEqual({ ms, expired: !counts });
      }
      expect(isBatchExpired(NOW, NOW)).toBe(true); // expiring exactly at now is expired
    });

    it('the isExpired filter is lte / gt the same now that classifies the rows and is returned as generatedAt', async () => {
      for (const [flag, cond] of [[true, { lte: NOW }], [false, { gt: NOW }]] as const) {
        const { prisma, calls } = fakePrisma([row({ expiryDate: NOW }), row({ id: 'b2', expiryDate: at(1) })]);
        const page = await new PrismaStockBatchOperationsReadAdapter(prisma).listBatches({ isExpired: flag }, 1, 20, NOW);
        expect(calls[0].args.where).toMatchObject({ AND: [{ expiryDate: cond }] });
        expect(page.generatedAt).toBe(NOW);
        expect(page.items.map((i) => i.isExpired)).toEqual([true, false]); // the boundary row is expired
      }
    });
  });

  describe('Module 04 adapter', () => {
    it('one paged findMany and one count over the same where, in one REPEATABLE READ transaction; soonest expiry first, id tiebreaker; live listings only', async () => {
      const { prisma, calls, options } = fakePrisma([]);
      await new PrismaStockBatchOperationsReadAdapter(prisma).listBatches({}, 2, 10, NOW);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(calls.map((c) => c.op)).toEqual(['findMany', 'count']);
      expect(calls[0].args).toMatchObject({ where: { listing: { deletedAt: null } }, orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }], skip: 10, take: 10 });
      expect(calls[1]).toEqual({ op: 'count', args: { where: calls[0].args.where } });
      const select = calls[0].args.select as Record<string, unknown>;
      expect(Object.keys(select).sort()).toEqual(['createdAt', 'expiryDate', 'id', 'listing', 'listingId', 'quantity', 'receivedAt']);
      expect(JSON.stringify(select)).not.toMatch(/batchNumber|supplier|movements|reservations|price|sellable|reserved/);
    });

    it('filters: listing, its owner ids, expiry window and the expired rule together (AND), created window', async () => {
      const { prisma, calls } = fakePrisma([]);
      const f: StockBatchOperationsFilter = { listingId: L1, pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', expiresFrom: at(-5), expiresTo: at(5), isExpired: false, createdFrom: NOW, createdTo: NOW };
      await new PrismaStockBatchOperationsReadAdapter(prisma).listBatches(f, 1, 20, NOW);
      expect(calls[0].args.where).toEqual({
        listing: { deletedAt: null, pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp' },
        listingId: L1,
        AND: [{ expiryDate: { gte: at(-5), lt: at(5) } }, { expiryDate: { gt: NOW } }],
        createdAt: { gte: NOW, lt: NOW },
      });
    });

    it('quantity is the batch’s own stored quantity, passed through — never a listing figure or a sum of movements; each batch once', async () => {
      const { prisma } = fakePrisma([row({ quantity: 7 }), row({ id: 'b2', quantity: 0, expiryDate: at(-1) })]);
      const page = await new PrismaStockBatchOperationsReadAdapter(prisma).listBatches({}, 1, 20, NOW);
      expect(page.items.map((i) => [i.batchId, i.quantity, i.isExpired])).toEqual([[B1, 7, false], ['b2', 0, true]]);
      for (const k of ['sellable', 'computedSellable', 'reserved', 'remaining', 'balance']) expect(page.items[0]).not.toHaveProperty(k);
    });

    it('detail: findFirst on id with a live listing; unknown or on a deleted listing → null', async () => {
      const { prisma, calls } = fakePrisma([row()]);
      const d = await new PrismaStockBatchOperationsReadAdapter(prisma).getBatch(B1, NOW);
      expect(calls[0].args.where).toEqual({ id: B1, listing: { deletedAt: null } });
      expect(d).toMatchObject({ generatedAt: NOW, batch: { batchId: B1, quantity: 7, isExpired: false } });
      expect(await new PrismaStockBatchOperationsReadAdapter(fakePrisma([]).prisma).getBatch(B1, NOW)).toBeNull();
    });
  });

  describe('Module 16 surface', () => {
    const view = (over: Partial<StockBatchOperationsView> = {}): StockBatchOperationsView => ({
      batchId: B1, listingId: L1, pharmacyId: 'ph', branchId: 'br', catalogProductId: 'cp', quantity: 7, expiryDate: at(1), isExpired: false, receivedAt: null, createdAt: NOW, ...over,
    });

    it('paging defaults/clamps; filters forwarded; empty list carries generatedAt; detail 404', async () => {
      const seen: Array<{ f: StockBatchOperationsFilter; page: number; size: number }> = [];
      const port: IStockBatchOperationsReadPort = {
        listBatches: async (f, page, size) => (seen.push({ f, page, size }), { generatedAt: NOW, items: [], total: 0, page, size }),
        getBatch: async () => null,
      };
      const q = new ListStockBatchOperationsQuery(port);
      expect(toStockBatchOperationsListResponse(await q.execute({}))).toEqual({ generatedAt: NOW.toISOString(), items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 2, size: 900, isExpired: true, listingId: L1 });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [2, MAX_STOCK_BATCH_PAGE_SIZE]]);
      expect(seen[1].f).toMatchObject({ isExpired: true, listingId: L1 });
      await expect(new GetStockBatchOperationsQuery(port).execute(B1)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('request validation: UUID ids, ISO dates, raw-string boolean, bounded paging; no batch-number/supplier/warning filter', () => {
      expect(dtoErrors({ listingId: L1, pharmacyId: L1, branchId: L1, catalogProductId: L1, expiresFrom: '2026-10-01', expiresTo: '2026-11-01', isExpired: 'false' })).toEqual([]);
      expect(plainToInstance(ListStockBatchOperationsQueryDto, { isExpired: 'false' }, { enableImplicitConversion: true }).isExpired).toBe('false');
      for (const [k, v] of [['listingId', 'L-1'], ['branchId', '7'], ['expiresFrom', 'next week'], ['isExpired', 'yes'], ['isExpired', 'TRUE'], ['createdTo', 'soon'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['batchNumber', 'supplier', 'expiringWithinDays', 'lowStock', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('explicit allow-lists: batch number, supplier and cost never reach the response; the detail adds only generatedAt', () => {
      const leaky = Object.assign(view(), { batchNumber: 'B-SECRET', supplier: 'SUPPLIER-SECRET', cost: 999 });
      expect(Object.keys(toStockBatchOperationsResponse(leaky))).toEqual(KEYS);
      const d = toStockBatchOperationsDetailResponse({ generatedAt: NOW, batch: leaky });
      expect(Object.keys(d)).toEqual([...KEYS, 'generatedAt']);
      expect(JSON.stringify(d)).not.toMatch(/SECRET|999/);
    });

    it('pharmacy:read:any (Works 47–50), GET-only; owner, manager and inventory-staff grants do not reach it', () => {
      expect(Reflect.getMetadata('path', AdminStockBatchOperationsController)).toBe('admin/operations/inventory/batches');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminStockBatchOperationsController)).toEqual(['pharmacy:read:any']);
      const methods = Object.getOwnPropertyNames(AdminStockBatchOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminStockBatchOperationsController.prototype[m as 'search'])).toBe(0);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['inventory:manage:org', 'pharmacy:manage:org'], 'pharmacy:read:any')).toBe(false);
    });
  });
});
