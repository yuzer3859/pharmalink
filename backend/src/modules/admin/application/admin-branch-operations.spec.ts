import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  BranchOperationsFilter,
  BranchOperationsView,
  IBranchOperationsReadPort,
} from '../../pharmacy-inventory/application/ports/inbound/branch-operations-read.port';
import { eligiblePharmacyWhere } from '../../pharmacy-inventory/infrastructure/persistence/listing-availability.sql';
import { listingCountColumns, toListingCounts } from '../../pharmacy-inventory/infrastructure/persistence/listing-counts.sql';
import { PrismaBranchOperationsReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-branch-operations-read.adapter';
import { AdminBranchOperationsController } from '../interface/controllers/admin-branch-operations.controller';
import { ListBranchOperationsQueryDto } from '../interface/dtos/branch-operations.dto';
import { toBranchOperationsListResponse, toBranchOperationsResponse } from '../interface/dtos/branch-operations.response';
import { GetBranchOperationsQuery, ListBranchOperationsQuery, MAX_BRANCH_OPERATIONS_PAGE_SIZE } from './queries/branch-operations.queries';

const NOW = new Date('2026-10-14T12:00:00Z');
const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const KEYS = ['branchId', 'pharmacyId', 'isActive', 'pharmacyEligible', 'createdAt', 'updatedAt', 'listings'];
const flat = (s: Prisma.Sql) => s.text.replace(/\s+/g, ' ').trim();
const shape = (s: string) => s.replace(/\$\d+/g, '$');

function fakePrisma(rows: unknown[], total: number, counts: unknown[]) {
  const statements: Prisma.Sql[] = [];
  let options: unknown;
  const answers = [rows, [{ count: BigInt(total) }], counts];
  const tx = { $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (statements.push(Prisma.sql(s, ...v)), answers[statements.length - 1]) };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown, o: unknown) => ((options = o), fn(tx)) } as unknown as PrismaService;
  return { prisma, statements, options: () => options };
}
const branchRow = (id: string, over: Record<string, unknown> = {}) => ({ id, pharmacyId: P1, isActive: true, createdAt: NOW, updatedAt: NOW, pharmacyEligible: true, ...over });

describe('Admin branch operations (Work 48)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListBranchOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('Module 04 adapter', () => {
    it('three statements in one REPEATABLE READ transaction — page, total, one listing GROUP BY over the page’s branches', async () => {
      const { prisma, statements, options } = fakePrisma([branchRow(B1), branchRow(B2)], 9, []);
      await new PrismaBranchOperationsReadAdapter(prisma).listBranches({}, 3, 2, NOW);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(statements).toHaveLength(3);
      const [page, count, listings] = statements.map(flat);
      // Each branch joined to its one pharmacy (many-to-one): no branch is repeated.
      expect(page).toMatch(/FROM "branches" br JOIN "pharmacies" ph ON ph\."id" = br\."pharmacyId" WHERE br\."deletedAt" IS NULL AND ph\."deletedAt" IS NULL ORDER BY br\."createdAt" DESC, br\."id" DESC LIMIT \$\d+ OFFSET \$\d+$/);
      expect(statements[0].values.slice(-2)).toEqual([2, 4]);
      expect(shape(page)).toContain(shape(`(${flat(eligiblePharmacyWhere('ph', NOW))}) AS "pharmacyEligible"`));
      expect(count).toBe('SELECT COUNT(*) AS "count" FROM "branches" br JOIN "pharmacies" ph ON ph."id" = br."pharmacyId" WHERE br."deletedAt" IS NULL AND ph."deletedAt" IS NULL');
      // The listing counts are the shared Work 47 columns, grouped per branch.
      expect(shape(listings)).toContain(shape(flat(listingCountColumns(NOW))));
      expect(listings).toMatch(/WHERE il\."branchId" IN \(\$\d+,\$\d+\) GROUP BY il\."branchId"$/);
      expect(listings).not.toMatch(/SUM\(il\.|COUNT\(DISTINCT/);
    });

    it('filters: pharmacy, stored active flag, purchasable inventory (EXISTS over Work 26’s fragments / NOT EXISTS), created window — on page and total alike', async () => {
      const cases: Array<[BranchOperationsFilter, RegExp]> = [
        [{ pharmacyId: P1 }, /br\."pharmacyId" = \$\d+/],
        [{ isActive: false }, /br\."isActive" = \$\d+/],
        [{ hasPurchasableInventory: true }, /AND EXISTS \(SELECT 1 FROM "inventory_listings" il JOIN "pharmacies" p ON p\."id" = il\."pharmacyId" JOIN "branches" b ON b\."id" = il\."branchId" WHERE il\."branchId" = br\."id" AND il\."isEnabled" = true/],
        [{ hasPurchasableInventory: false }, /AND NOT EXISTS \(SELECT 1 FROM "inventory_listings" il/],
        [{ createdFrom: NOW, createdTo: NOW }, /br\."createdAt" >= \$\d+ AND br\."createdAt" < \$\d+/],
      ];
      for (const [f, re] of cases) {
        const { prisma, statements } = fakePrisma([], 0, []);
        await new PrismaBranchOperationsReadAdapter(prisma).listBranches(f, 1, 20, NOW);
        expect({ f, page: re.test(flat(statements[0])), count: re.test(flat(statements[1])) }).toEqual({ f, page: true, count: true });
        expect(statements).toHaveLength(2); // empty page: no grouped query
      }
    });

    it('maps per branch: active branch of an ineligible pharmacy keeps isActive and shows pharmacyEligible false; a branch with no listings gets zeros', async () => {
      const { prisma } = fakePrisma(
        [branchRow(B1), branchRow(B2, { isActive: true, pharmacyEligible: false })],
        2,
        [{ branchId: B1, total: 4n, enabled: 3n, inStock: 2n, purchasable: 1n }],
      );
      const page = await new PrismaBranchOperationsReadAdapter(prisma).listBranches({}, 1, 20, NOW);
      expect(page.items[0]).toMatchObject({ isActive: true, pharmacyEligible: true, listings: { total: 4, enabled: 3, disabled: 1, inStock: 2, outOfStock: 1, customerPurchasable: 1, customerUnpurchasable: 3 } });
      expect(page.items[1]).toMatchObject({ isActive: true, pharmacyEligible: false, listings: toListingCounts(undefined) });
      expect(toListingCounts(undefined)).toEqual({ total: 0, enabled: 0, disabled: 0, inStock: 0, outOfStock: 0, customerPurchasable: 0, customerUnpurchasable: 0 });
    });

    it('detail: the same statements restricted to one live branch of a live pharmacy; unknown → null', async () => {
      const { prisma, statements } = fakePrisma([], 0, []);
      expect(await new PrismaBranchOperationsReadAdapter(prisma).getBranch(B1, NOW)).toBeNull();
      expect(flat(statements[0])).toMatch(/WHERE br\."deletedAt" IS NULL AND ph\."deletedAt" IS NULL AND br\."id" = \$\d+/);
    });
  });

  describe('Module 16 surface', () => {
    const view = (over: Partial<BranchOperationsView> = {}): BranchOperationsView => ({
      branchId: B1, pharmacyId: P1, isActive: true, pharmacyEligible: true, createdAt: NOW, updatedAt: NOW,
      listings: { total: 1, enabled: 1, disabled: 0, inStock: 1, outOfStock: 0, customerPurchasable: 1, customerUnpurchasable: 0 }, ...over,
    });

    it('paging defaults/clamps; filters forwarded; empty list; detail 404', async () => {
      const seen: Array<{ f: BranchOperationsFilter; page: number; size: number }> = [];
      const port: IBranchOperationsReadPort = { listBranches: async (f, page, size) => (seen.push({ f, page, size }), { items: [], total: 0, page, size }), getBranch: async () => null };
      const q = new ListBranchOperationsQuery(port);
      expect(toBranchOperationsListResponse(await q.execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 2, size: 999, pharmacyId: P1, isActive: false, hasPurchasableInventory: true });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [2, MAX_BRANCH_OPERATIONS_PAGE_SIZE]]);
      expect(seen[1].f).toMatchObject({ pharmacyId: P1, isActive: false, hasPurchasableInventory: true });
      await expect(new GetBranchOperationsQuery(port).execute(B1)).rejects.toMatchObject({ httpStatus: 404 });
    });

    it('request validation: UUID pharmacyId, raw-string booleans, ISO dates, bounded paging; unknown parameters 400', () => {
      expect(dtoErrors({ pharmacyId: P1, isActive: 'false', hasPurchasableInventory: 'true', createdFrom: '2026-10-01' })).toEqual([]);
      expect(plainToInstance(ListBranchOperationsQueryDto, { isActive: 'false' }, { enableImplicitConversion: true }).isActive).toBe('false');
      for (const [k, v] of [['pharmacyId', 'ph-1'], ['isActive', 'yes'], ['isActive', 'TRUE'], ['hasPurchasableInventory', '1'], ['createdTo', 'soon'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['name', 'city', 'addressLine', 'phone', 'status', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('explicit allow-list: name, address, city, coordinates and phone never reach the response', () => {
      const leaky = Object.assign(view(), { name: 'Bole Branch', addressLine: 'Africa Ave', city: 'Addis', lat: 9.03, lng: 38.74, phone: '+251911' });
      const res = toBranchOperationsResponse(leaky);
      expect(Object.keys(res)).toEqual(KEYS);
      expect(JSON.stringify(res)).not.toMatch(/Bole|Africa|Addis|9\.03|38\.74|\+2519/);
    });

    it('pharmacy:read:any (Work 47), GET-only; owner/manager/org grants do not reach it', () => {
      expect(Reflect.getMetadata('path', AdminBranchOperationsController)).toBe('admin/operations/branches');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminBranchOperationsController)).toEqual(['pharmacy:read:any']);
      const methods = Object.getOwnPropertyNames(AdminBranchOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminBranchOperationsController.prototype[m as 'search'])).toBe(0);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['pharmacy:manage:org', 'inventory:manage:org', 'analytics:read'], 'pharmacy:read:any')).toBe(false);
    });
  });
});
