import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  IPharmacyOperationsReadPort,
  LicenseStatus,
  PharmacyOperationsFilter,
  PharmacyOperationsView,
  TransactingStatus,
} from '../../pharmacy-inventory/application/ports/inbound/pharmacy-operations-read.port';
import { TransactingEligibilityPolicy } from '../../pharmacy-inventory/domain/services/transacting-eligibility.policy';
import { availableListingWhere, eligiblePharmacyWhere, unexpiredSellablePositive } from '../../pharmacy-inventory/infrastructure/persistence/listing-availability.sql';
import { PrismaPharmacyOperationsReadAdapter } from '../../pharmacy-inventory/infrastructure/persistence/prisma-pharmacy-operations-read.adapter';
import { AdminPharmacyOperationsController } from '../interface/controllers/admin-pharmacy-operations.controller';
import { ListPharmacyOperationsQueryDto } from '../interface/dtos/pharmacy-operations.dto';
import { toPharmacyOperationsListResponse, toPharmacyOperationsResponse } from '../interface/dtos/pharmacy-operations.response';
import { GetPharmacyOperationsQuery, ListPharmacyOperationsQuery, MAX_PHARMACY_OPERATIONS_PAGE_SIZE } from './queries/pharmacy-operations.queries';

const NOW = new Date('2026-10-14T12:00:00Z');
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const KEYS = ['pharmacyId', 'transactingStatus', 'licenseStatus', 'licenseExpiresAt', 'eligible', 'createdAt', 'updatedAt', 'branches', 'listings'];
const LISTING_KEYS = ['total', 'enabled', 'disabled', 'inStock', 'outOfStock', 'customerPurchasable', 'customerUnpurchasable'];
const flat = (s: Prisma.Sql) => s.text.replace(/\s+/g, ' ').trim();
/** Placeholder numbers shift when fragments are embedded; compare shapes. */
const shape = (s: Prisma.Sql | string) => (typeof s === 'string' ? s : flat(s)).replace(/\$\d+/g, '$');

/** A transaction client double that answers the four statements in order and records them. */
function fakePrisma(rows: unknown[], total: number, listings: unknown[], branches: unknown[]) {
  const statements: Prisma.Sql[] = [];
  let options: unknown;
  const answers = [rows, [{ count: BigInt(total) }], listings, branches];
  const tx = { $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (statements.push(Prisma.sql(s, ...v)), answers[statements.length - 1]) };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown, o: unknown) => ((options = o), fn(tx)) } as unknown as PrismaService;
  return { prisma, statements, options: () => options };
}
const pharmacyRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, transactingStatus: 'ACTIVE', licenseStatus: 'VALID', licenseExpiresAt: null, createdAt: NOW, updatedAt: NOW, eligible: true, ...over,
});

describe('Admin pharmacy operations (Work 47)', () => {
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListPharmacyOperationsQueryDto, plain, { enableImplicitConversion: true }), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  describe('rules reused, not restated', () => {
    it('eligiblePharmacyWhere is the provider half of availableListingWhere, condition for condition', () => {
      const available = flat(availableListingWhere(NOW));
      expect(available).toContain(flat(eligiblePharmacyWhere('p', NOW)));
      expect(flat(eligiblePharmacyWhere('ph', NOW))).toBe(flat(eligiblePharmacyWhere('p', NOW)).replace(/\bp\./g, 'ph.'));
    });

    it('…and it matches TransactingEligibilityPolicy case by case (status, licence, expiry before / at / after now)', () => {
      const sqlSays = (t: string, l: string, exp: Date | null) => t === 'ACTIVE' && l === 'VALID' && (exp === null || exp.getTime() > NOW.getTime());
      for (const t of Object.values(TransactingStatus)) {
        for (const l of Object.values(LicenseStatus)) {
          for (const exp of [null, new Date(NOW.getTime() - 1), NOW, new Date(NOW.getTime() + 1)]) {
            expect({ t, l, exp, sql: sqlSays(t, l, exp) }).toEqual({ t, l, exp, sql: TransactingEligibilityPolicy.isEligible({ transactingStatus: t, licenseStatus: l, licenseExpiresAt: exp }, NOW) });
          }
        }
      }
      // The SQL really has the three conditions sqlSays encodes.
      expect(flat(eligiblePharmacyWhere('ph', NOW))).toBe(`ph."transactingStatus" = 'ACTIVE' AND ph."licenseStatus" = 'VALID' AND (ph."licenseExpiresAt" IS NULL OR ph."licenseExpiresAt" > $1)`);
    });
  });

  describe('Module 04 adapter', () => {
    it('four statements in one REPEATABLE READ transaction — page, total, one listing GROUP BY, one branch GROUP BY — whatever the page size', async () => {
      const { prisma, statements, options } = fakePrisma([pharmacyRow(P1), pharmacyRow(P2)], 7, [], []);
      await new PrismaPharmacyOperationsReadAdapter(prisma).listPharmacies({}, 2, 2, NOW);
      expect(options()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(statements).toHaveLength(4);
      const [page, count, listings, branches] = statements.map(flat);
      expect(page).toMatch(/FROM "pharmacies" ph WHERE ph\."deletedAt" IS NULL ORDER BY ph\."createdAt" DESC, ph\."id" DESC LIMIT \$\d+ OFFSET \$\d+$/);
      expect(statements[0].values.slice(-2)).toEqual([2, 2]);
      expect(count).toBe('SELECT COUNT(*) AS "count" FROM "pharmacies" ph WHERE ph."deletedAt" IS NULL');
      expect(listings).toContain('GROUP BY il."pharmacyId"');
      expect(shape(listings)).toContain(shape(`COUNT(*) FILTER (WHERE ${flat(availableListingWhere(NOW))} AND ${flat(unexpiredSellablePositive(NOW))}) AS "purchasable"`));
      expect(branches).toContain('FROM "branches" b WHERE b."pharmacyId" IN ($');
      expect(branches).toContain('GROUP BY b."pharmacyId"');
      expect(statements[2].values).toEqual(expect.arrayContaining([P1, P2]));
    });

    it('listing counts are Work 08’s tracked definitions and Work 26’s purchasable rule, counted per listing row', async () => {
      const { prisma, statements } = fakePrisma([pharmacyRow(P1)], 1, [], []);
      await new PrismaPharmacyOperationsReadAdapter(prisma).listPharmacies({}, 1, 20, NOW);
      const listings = flat(statements[2]);
      expect(listings).toContain('COUNT(*) FILTER (WHERE il."deletedAt" IS NULL) AS "total"');
      expect(listings).toContain('COUNT(*) FILTER (WHERE il."deletedAt" IS NULL AND il."isEnabled" = true) AS "enabled"');
      expect(listings).toContain('COUNT(*) FILTER (WHERE il."deletedAt" IS NULL AND il."isEnabled" = true AND il."sellable" > 0) AS "inStock"');
      expect(listings).not.toMatch(/SUM\(il\.|COUNT\(DISTINCT/);
      expect(flat(statements[3])).toContain('COUNT(*) FILTER (WHERE b."deletedAt" IS NULL AND b."isActive" = true) AS "active"');
    });

    it('filters: stored status, eligibility (the fragment / its negation), purchasable inventory (EXISTS over Work 26’s fragments / NOT EXISTS), created window', async () => {
      const filters: Array<[PharmacyOperationsFilter, RegExp]> = [
        [{ transactingStatus: TransactingStatus.SUSPENDED }, /ph\."transactingStatus" = \$\d+::"TransactingStatus"/],
        [{ eligible: true }, /AND \(ph\."transactingStatus" = 'ACTIVE'/],
        [{ eligible: false }, /AND NOT \(ph\."transactingStatus" = 'ACTIVE'/],
        [{ hasPurchasableInventory: true }, /AND EXISTS \(SELECT 1 FROM "inventory_listings" il JOIN "pharmacies" p ON p\."id" = il\."pharmacyId" JOIN "branches" b ON b\."id" = il\."branchId" WHERE il\."pharmacyId" = ph\."id" AND il\."isEnabled" = true/],
        [{ hasPurchasableInventory: false }, /AND NOT EXISTS \(SELECT 1 FROM "inventory_listings" il/],
        [{ createdFrom: NOW, createdTo: NOW }, /ph\."createdAt" >= \$\d+ AND ph\."createdAt" < \$\d+/],
      ];
      for (const [f, re] of filters) {
        const { prisma, statements } = fakePrisma([], 0, [], []);
        await new PrismaPharmacyOperationsReadAdapter(prisma).listPharmacies(f, 1, 20, NOW);
        expect({ f, page: re.test(flat(statements[0])), count: re.test(flat(statements[1])) }).toEqual({ f, page: true, count: true });
        expect(statements).toHaveLength(2); // empty page: no grouped queries
      }
    });

    it('maps per pharmacy; a pharmacy with no branches or listings gets zeros; derived figures are differences of the same row', async () => {
      const { prisma } = fakePrisma(
        [pharmacyRow(P1), pharmacyRow(P2, { transactingStatus: 'ACTIVE', licenseStatus: 'EXPIRED', eligible: false })],
        2,
        [{ pharmacyId: P1, total: 5n, enabled: 4n, inStock: 3n, purchasable: 2n }],
        [{ pharmacyId: P1, total: 3n, active: 2n }],
      );
      const page = await new PrismaPharmacyOperationsReadAdapter(prisma).listPharmacies({}, 1, 20, NOW);
      expect(page.items[0]).toMatchObject({ eligible: true, branches: { total: 3, active: 2 }, listings: { total: 5, enabled: 4, disabled: 1, inStock: 3, outOfStock: 1, customerPurchasable: 2, customerUnpurchasable: 3 } });
      // Stored ACTIVE, yet ineligible — eligibility is the rule, not the status.
      expect(page.items[1]).toMatchObject({ transactingStatus: 'ACTIVE', eligible: false, branches: { total: 0, active: 0 }, listings: { total: 0, customerPurchasable: 0, customerUnpurchasable: 0 } });
    });

    it('detail: the same statements restricted to one live id; unknown → null', async () => {
      const { prisma, statements } = fakePrisma([], 0, [], []);
      expect(await new PrismaPharmacyOperationsReadAdapter(prisma).getPharmacy(P1, NOW)).toBeNull();
      expect(flat(statements[0])).toMatch(/WHERE ph\."deletedAt" IS NULL AND ph\."id" = \$\d+/);
      expect(statements[0].values).toContain(P1);
    });
  });

  describe('Module 16 surface', () => {
    const view = (over: Partial<PharmacyOperationsView> = {}): PharmacyOperationsView => ({
      pharmacyId: P1, transactingStatus: TransactingStatus.ACTIVE, licenseStatus: LicenseStatus.VALID, licenseExpiresAt: null, eligible: true, createdAt: NOW, updatedAt: NOW,
      branches: { total: 1, active: 1 }, listings: { total: 2, enabled: 2, disabled: 0, inStock: 2, outOfStock: 0, customerPurchasable: 1, customerUnpurchasable: 1 }, ...over,
    });

    it('paging defaults/clamps, filters forwarded; empty list; detail 404', async () => {
      const seen: Array<{ f: PharmacyOperationsFilter; page: number; size: number }> = [];
      const port: IPharmacyOperationsReadPort = { listPharmacies: async (f, page, size) => (seen.push({ f, page, size }), { items: [], total: 0, page, size }), getPharmacy: async () => null };
      const q = new ListPharmacyOperationsQuery(port);
      expect(toPharmacyOperationsListResponse(await q.execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
      await q.execute({ page: 2, size: 500, eligible: false, hasPurchasableInventory: true, transactingStatus: TransactingStatus.PENDING });
      expect(seen.map((s) => [s.page, s.size])).toEqual([[1, 20], [2, MAX_PHARMACY_OPERATIONS_PAGE_SIZE]]);
      expect(seen[1].f).toMatchObject({ eligible: false, hasPurchasableInventory: true, transactingStatus: 'PENDING' });
      await expect(new GetPharmacyOperationsQuery(port).execute(P1)).rejects.toMatchObject({ httpStatus: 404 });
      await new GetPharmacyOperationsQuery(port).execute(P1).catch((e) => expect(e).toBeInstanceOf(ApiException));
    });

    it('request validation: real TransactingStatus values; raw-string booleans; ISO dates; bounded paging; unknown parameters 400', () => {
      expect(Object.values(TransactingStatus)).toEqual(['ACTIVE', 'SUSPENDED', 'PENDING']);
      for (const transactingStatus of Object.values(TransactingStatus)) expect(dtoErrors({ transactingStatus })).toEqual([]);
      expect(dtoErrors({ eligible: 'false', hasPurchasableInventory: 'true', createdFrom: '2026-10-01' })).toEqual([]);
      for (const [k, v] of [['transactingStatus', 'ELIGIBLE'], ['eligible', 'yes'], ['eligible', 'TRUE'], ['hasPurchasableInventory', '1'], ['createdFrom', 'last week'], ['page', 0], ['size', 101]] as const) {
        expect({ k, v, errors: dtoErrors({ [k]: v }) }).toEqual({ k, v, errors: [k] });
      }
      for (const field of ['name', 'ownerUserId', 'licenseNumber', 'city', 'q']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });

    it('explicit allow-list: name, owner, contact, address, coordinates and licence number never reach the response', () => {
      const leaky = Object.assign(view(), { displayName: 'Bole Pharmacy', ownerUserId: 'user-secret', phone: '+251911', addressLine: 'Africa Ave', lat: 9.03, licenseNumber: 'LIC-SECRET', organizationId: 'org-secret' });
      const res = toPharmacyOperationsResponse(leaky);
      expect(Object.keys(res)).toEqual(KEYS);
      expect(Object.keys(res.listings)).toEqual(LISTING_KEYS);
      expect(JSON.stringify(res)).not.toMatch(/Bole|secret|SECRET|\+2519|Africa|9\.03/);
    });

    it('pharmacy:read:any is ADMIN-only (SUPER_ADMIN by wildcard); owner, analytics and verification grants do not imply it; it implies no action', () => {
      expect(Reflect.getMetadata('path', AdminPharmacyOperationsController)).toBe('admin/operations/pharmacies');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminPharmacyOperationsController)).toEqual(['pharmacy:read:any']);
      const methods = Object.getOwnPropertyNames(AdminPharmacyOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) expect(Reflect.getMetadata('method', AdminPharmacyOperationsController.prototype[m as 'search'])).toBe(0);
      expect(PERMISSIONS.find((p) => p.key === 'pharmacy:read:any')).toEqual({ key: 'pharmacy:read:any', resource: 'pharmacy', action: 'read', scope: 'any' });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'pharmacy:read:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['pharmacy:manage:org', 'analytics:read', 'provider:verify:any', 'inventory:manage:org'], 'pharmacy:read:any')).toBe(false);
      for (const action of ['pharmacy:manage:any', 'pharmacy:suspend:any', 'inventory:manage:any', 'provider:verify:any']) {
        expect({ action, ok: hasPermission(['pharmacy:read:any'], action) }).toEqual({ action, ok: false });
      }
    });
  });
});
