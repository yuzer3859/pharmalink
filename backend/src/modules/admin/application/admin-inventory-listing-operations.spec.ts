import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  IInventoryListingOperationsReadPort,
  InventoryListingOperationsDetail,
  InventoryListingOperationsFilter,
} from '../../pharmacy-inventory/application/ports/inbound/inventory-listing-operations-read.port';
import { SellableStockCalculator } from '../../pharmacy-inventory/domain/services/sellable-stock.calculator';
import {
  availableListingWhere,
  computedSellableQuantity,
  unexpiredBatchQuantity,
  unexpiredSellablePositive,
} from '../../pharmacy-inventory/infrastructure/persistence/listing-availability.sql';
import { PrismaInventoryListingOperationsReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-inventory-listing-operations-read.adapter';
import { AdminInventoryListingOperationsController } from '../interface/controllers/admin-inventory-listing-operations.controller';
import { ListInventoryListingOperationsQueryDto } from '../interface/dtos/inventory-listing-operations.dto';
import {
  toInventoryListingOperationsDetailResponse,
  toInventoryListingOperationsListResponse,
  toInventoryListingOperationsResponse,
} from '../interface/dtos/inventory-listing-operations.response';
import { GetInventoryListingOperationsQuery, ListInventoryListingOperationsQuery, MAX_LISTING_OPERATIONS_PAGE_SIZE } from './queries/inventory-listing-operations.queries';

const NOW = new Date('2026-10-14T12:00:00Z');
const L1 = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const KEYS = ['listingId', 'pharmacyId', 'branchId', 'catalogProductId', 'isEnabled', 'storedSellable', 'computedSellable', 'customerPurchasable', 'createdAt', 'updatedAt'];
const flat = (s: Prisma.Sql) => s.text.replace(/\s+/g, ' ').trim();
/** Placeholder numbers shift and a fragment's leading newline leaves `( ` when embedded; compare shapes. */
const shape = (s: string) => s.replace(/\$\d+/g, '$').replace(/\(\s+/g, '(');

function fakePrisma(rows: unknown[], total: number) {
  const statements: Prisma.Sql[] = [];
  let options: unknown;
  const answers = [rows, [{ count: BigInt(total) }]];
  const tx = { $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (statements.push(Prisma.sql(s, ...v)), answers[statements.length - 1]) };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown, o: unknown) => ((options = o), fn(tx)) } as unknown as PrismaService;
  return { prisma, statements, options: () => options };
}
const row = (over: Record<string, unknown> = {}) => ({
  id: L1, pharmacyId: P1, branchId: 'b', catalogProductId: 'c', isEnabled: true, sellable: 5, reserved: 2, createdAt: NOW, updatedAt: NOW,
  computedSellable: 0n, customerPurchasable: false, unexpiredBatchCount: 1n, unexpiredBatchQuantity: 2n, ...over,
});

describe('Admin inventory listing operations (Work 49)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListInventoryListingOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('computed sellable stock is SellableStockCalculator, boundary included', () => {
    /** The two SQL fragments, evaluated by hand over the same inputs — the SQL text is pinned below. */
    const sqlQuantity = (batches: Array<{ quantity: number; expiryDate: Date }>, now: Date) => batches.filter((b) => b.expiryDate > now).reduce((s, b) => s + b.quantity, 0);
    const sqlComputed = (batches: Array<{ quantity: number; expiryDate: Date }>, reserved: number, now: Date) => Math.max(0, sqlQuantity(batches, now) - reserved);

    it('the fragments say exactly: Σ quantity where expiryDate > now; GREATEST(0, that − il.reserved)', () => {
      expect(flat(unexpiredBatchQuantity(NOW))).toBe('(SELECT COALESCE(SUM(sb."quantity"), 0) FROM "stock_batches" sb WHERE sb."listingId" = il."id" AND sb."expiryDate" > $1)');
      expect(shape(flat(computedSellableQuantity(NOW)))).toBe(shape(`GREATEST(0, ${flat(unexpiredBatchQuantity(NOW))} - il."reserved")`));
    });

    it('matches the calculator case by case: expiring exactly at now is expired; reservations subtract; never negative', () => {
      const at = (ms: number) => new Date(NOW.getTime() + ms);
      const cases: Array<[Array<{ quantity: number; expiryDate: Date }>, number]> = [
        [[], 0],
        [[{ quantity: 5, expiryDate: at(-1) }], 0], // expired
        [[{ quantity: 5, expiryDate: NOW }], 0], // exactly at now → expired
        [[{ quantity: 5, expiryDate: at(1) }], 0], // a millisecond later → counts
        [[{ quantity: 5, expiryDate: at(1) }, { quantity: 3, expiryDate: at(-1) }], 2], // reserved 2 of the live 5
        [[{ quantity: 2, expiryDate: at(1) }], 5], // more reserved than on hand → 0, not negative
        [[{ quantity: 4, expiryDate: at(1) }, { quantity: 6, expiryDate: at(10) }], 4], // several batches sum once
      ];
      for (const [batches, reserved] of cases) {
        expect({ batches: batches.length, reserved, sql: sqlComputed(batches, reserved, NOW) }).toEqual({ batches: batches.length, reserved, sql: SellableStockCalculator.computeSellable(batches, reserved, NOW) });
      }
    });

    it('computedSellable > 0 exactly when Work 26’s unexpiredSellablePositive holds (GREATEST(0, x) > 0 ⇔ x > 0)', () => {
      expect(shape(flat(unexpiredSellablePositive(NOW)))).toBe(shape(`${flat(unexpiredBatchQuantity(NOW)).slice(1, -1).replace(/^/, '(')}) - il."reserved" > 0`));
      for (const x of [-3, 0, 1, 7]) expect(Math.max(0, x) > 0).toBe(x > 0);
    });
  });

  describe('Module 04 adapter', () => {
    it('two statements in one REPEATABLE READ transaction over AVAILABLE_LISTING_FROM (many-to-one joins; batches only via sub-selects)', async () => {
      const { prisma, statements, options } = fakePrisma([row()], 7);
      await new PrismaInventoryListingOperationsReadAdapter(prisma).listListings({}, 2, 5, NOW);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(statements).toHaveLength(2);
      const [page, count] = statements.map(flat);
      expect(page).toMatch(/FROM "inventory_listings" il JOIN "pharmacies" p ON p\."id" = il\."pharmacyId" JOIN "branches" b ON b\."id" = il\."branchId" WHERE il\."deletedAt" IS NULL ORDER BY il\."createdAt" DESC, il\."id" DESC LIMIT \$\d+ OFFSET \$\d+$/);
      expect(statements[0].values.slice(-2)).toEqual([5, 5]);
      expect(page).not.toMatch(/JOIN "stock_batches"|JOIN "stock_reservations"|stock_reservations/);
      expect(shape(page)).toContain(shape(`${flat(computedSellableQuantity(NOW))} AS "computedSellable"`));
      expect(shape(page)).toContain(shape(`(${flat(availableListingWhere(NOW))} AND ${flat(unexpiredSellablePositive(NOW))}) AS "customerPurchasable"`));
      expect(count).toBe('SELECT COUNT(*) AS "count" FROM "inventory_listings" il JOIN "pharmacies" p ON p."id" = il."pharmacyId" JOIN "branches" b ON b."id" = il."branchId" WHERE il."deletedAt" IS NULL');
    });

    it('filters on page and total alike: ids, stored flag, stored sellable, Work 26 purchasable (and its negation), created window', async () => {
      const cases: Array<[InventoryListingOperationsFilter, RegExp]> = [
        [{ pharmacyId: P1, branchId: L1, catalogProductId: L1 }, /il\."pharmacyId" = \$\d+ AND il\."branchId" = \$\d+ AND il\."catalogProductId" = \$\d+/],
        [{ isEnabled: false }, /il\."isEnabled" = \$\d+/],
        [{ hasStoredSellableStock: true }, /AND il\."sellable" > 0/],
        [{ hasStoredSellableStock: false }, /AND il\."sellable" <= 0/],
        [{ customerPurchasable: true }, /AND \(\s*il\."isEnabled" = true AND il\."deletedAt" IS NULL AND il\."sellable" > 0 AND b\."isActive" = true/],
        [{ customerPurchasable: false }, /AND NOT \(\s*il\."isEnabled" = true/],
        [{ createdFrom: NOW, createdTo: NOW }, /il\."createdAt" >= \$\d+ AND il\."createdAt" < \$\d+/],
      ];
      for (const [f, re] of cases) {
        const { prisma, statements } = fakePrisma([], 0);
        await new PrismaInventoryListingOperationsReadAdapter(prisma).listListings(f, 1, 20, NOW);
        expect({ f, page: re.test(flat(statements[0])), count: re.test(flat(statements[1])) }).toEqual({ f, page: true, count: true });
      }
    });

    it('maps stored and computed separately — positive stored, zero computed is reported as such; the detail adds the diagnostics', async () => {
      const { prisma } = fakePrisma([row({ sellable: 5, computedSellable: 0n, reserved: 2, unexpiredBatchQuantity: 2n, unexpiredBatchCount: 1n })], 1);
      const page = await new PrismaInventoryListingOperationsReadAdapter(prisma).listListings({}, 1, 20, NOW);
      expect(page.items[0]).toMatchObject({ storedSellable: 5, computedSellable: 0, customerPurchasable: false });
      expect(Object.keys(page.items[0])).toEqual(KEYS);
      const d = fakePrisma([row({ sellable: 5, computedSellable: 0n, reserved: 2, unexpiredBatchQuantity: 2n, unexpiredBatchCount: 1n })], 1);
      expect(await new PrismaInventoryListingOperationsReadAdapter(d.prisma).getListing(L1, NOW)).toMatchObject({
        storedSellable: 5, computedSellable: 0, reserved: 2, unexpiredBatchCount: 1, unexpiredBatchQuantity: 2, storedMatchesComputed: false,
      });
      expect(flat(d.statements[0])).toMatch(/WHERE il\."deletedAt" IS NULL AND il\."id" = \$\d+/);
      expect(await new PrismaInventoryListingOperationsReadAdapter(fakePrisma([], 0).prisma).getListing(L1, NOW)).toBeNull();
    });
  });

  describe('Module 16 surface', () => {
    const detail = (over: Partial<InventoryListingOperationsDetail> = {}): InventoryListingOperationsDetail => ({
      listingId: L1, pharmacyId: P1, branchId: 'b', catalogProductId: 'c', isEnabled: true, storedSellable: 3, computedSellable: 3, customerPurchasable: true,
      createdAt: NOW, updatedAt: NOW, reserved: 0, unexpiredBatchCount: 1, unexpiredBatchQuantity: 3, storedMatchesComputed: true, ...over,
    });

    it('paging defaults/clamps; filters forwarded; empty list; detail 404', async () => {
      const seen: Array<{ f: InventoryListingOperationsFilter; page: number; size: number }> = [];
      const port: IInventoryListingOperationsReadPort = { listListings: async (f, page, size) => (seen.push({ f, page, size }), { items: [], total: 0, page, size }), getListing: async () => null };
      const q = new ListInventoryListingOperationsQuery(port);
      expect(toInventoryListingOperationsListResponse(await q.execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 3, size: 1000, isEnabled: false, hasStoredSellableStock: true, customerPurchasable: false, catalogProductId: L1 });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [3, MAX_LISTING_OPERATIONS_PAGE_SIZE]]);
      expect(seen[1].f).toMatchObject({ isEnabled: false, hasStoredSellableStock: true, customerPurchasable: false, catalogProductId: L1 });
      await expect(new GetInventoryListingOperationsQuery(port).execute(L1)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('request validation: UUID ids, raw-string booleans, ISO dates, bounded paging; unknown parameters 400', () => {
      expect(dtoErrors({ pharmacyId: P1, branchId: L1, catalogProductId: L1, isEnabled: 'false', hasStoredSellableStock: 'true', customerPurchasable: 'false', createdFrom: '2026-10-01' })).toEqual([]);
      expect(plainToInstance(ListInventoryListingOperationsQueryDto, { customerPurchasable: 'false' }, { enableImplicitConversion: true }).customerPurchasable).toBe('false');
      for (const [k, v] of [['pharmacyId', 'ph'], ['branchId', '7'], ['catalogProductId', 'AMOX'], ['isEnabled', 'yes'], ['hasStoredSellableStock', 'TRUE'], ['customerPurchasable', '1'], ['createdTo', 'soon'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['lowStock', 'productName', 'price', 'reserved', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('explicit allow-lists: list rows carry only the core fields; detail adds four diagnostics; no name, price, batch, reservation or user', () => {
      const leaky = Object.assign(detail(), { productName: 'Amoxicillin', price: 1000, batches: [{ supplier: 'SUP-SECRET' }], reservations: [{ orderId: 'ord-secret' }], customerUserId: 'cust-secret' });
      expect(Object.keys(toInventoryListingOperationsResponse(leaky))).toEqual(KEYS);
      const d = toInventoryListingOperationsDetailResponse(leaky);
      expect(Object.keys(d)).toEqual([...KEYS, 'reserved', 'unexpiredBatchCount', 'unexpiredBatchQuantity', 'storedMatchesComputed']);
      expect(JSON.stringify(d)).not.toMatch(/Amoxicillin|1000|SECRET|secret/);
    });

    it('pharmacy:read:any (Works 47/48), GET-only; owner/manager/inventory grants do not reach it', () => {
      expect(Reflect.getMetadata('path', AdminInventoryListingOperationsController)).toBe('admin/operations/inventory/listings');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminInventoryListingOperationsController)).toEqual(['pharmacy:read:any']);
      const methods = Object.getOwnPropertyNames(AdminInventoryListingOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminInventoryListingOperationsController.prototype[m as 'search'])).toBe(0);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['inventory:manage:org', 'pharmacy:manage:org', 'analytics:read'], 'pharmacy:read:any')).toBe(false);
    });
  });
});
