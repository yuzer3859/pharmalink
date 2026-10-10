import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { ErrorCode } from '../../src/shared/errors/error-codes';
import { auth, body, createUserWithRole, errorOf } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';

const REVIEW = '/admin/catalog/review';
const STATUSES = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'DEPRECATED', 'DELISTED'];
/** The targets Module 03's `ChangeProductStatusDto` admits at all. */
const TARGETS = ['ACTIVE', 'DEPRECATED', 'DELISTED', 'DRAFT'];

interface Item {
  id: string;
  type: string;
  genericName: string | null;
  brandName: string | null;
  nameEn: string | null;
  manufacturerName: string | null;
  price: number | null;
  status: string;
  allowedTransitions: string[];
  createdAt: string;
  updatedAt: string;
}

interface Page {
  items: Item[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 16 Work 09 against real PostgreSQL and the real HTTP stack.
 *
 * Every product is created and moved through Module 03's own routes, then looked for on the
 * review list. What can only be shown here: that the list is Module 03's rows in the state
 * asked for, that each row's `allowedTransitions` is exactly what Module 03's status route
 * accepts, that the decision itself stays on that route with its single audit entry, and that
 * Module 16 adds no route over Module 03's and writes nothing.
 */
describe('Admin catalogue review (e2e)', () => {
  let ctx: TestContext;
  /** `catalog:manage:any`. */
  let admin: Awaited<ReturnType<typeof createUserWithRole>>;
  let manufacturerId: string;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
    admin = await createUserWithRole(ctx, 'ADMIN');
    const res = await request(ctx.server)
      .post('/admin/catalog/manufacturers')
      .set(...auth(admin.accessToken))
      .send({ name: 'Acme Pharma', country: 'Ethiopia' })
      .expect(201);
    manufacturerId = body(res).id as string;
  });

  const list = (token: string, query: Record<string, unknown> = {}) =>
    request(ctx.server).get(REVIEW).query(query).set(...auth(token));
  const read = async (query: Record<string, unknown> = {}) =>
    body(await list(admin.accessToken, query).expect(200)) as unknown as Page;

  // -------------------------------------------------------------------------------------------
  // Fixtures — through Module 03's own routes
  // -------------------------------------------------------------------------------------------

  /** A DRAFT product, created by Module 03. Names are unique so the dedup key never collides. */
  async function createProduct(overrides: Record<string, unknown> = {}): Promise<string> {
    seq += 1;
    const res = await request(ctx.server)
      .post('/admin/catalog/products')
      .set(...auth(admin.accessToken))
      .send({
        type: 'MEDICINE',
        genericName: `Generic${seq}`,
        manufacturerId,
        dosageForm: 'TABLET',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        nameEn: `Product ${seq}`,
        ...overrides,
      })
      .expect(201);
    return body(res).id as string;
  }

  const changeStatus = (id: string, status: string) =>
    request(ctx.server)
      .post(`/admin/catalog/products/${id}/status`)
      .set(...auth(admin.accessToken))
      .send({ status, reason: 'e2e' });

  /**
   * The shortest legal path from DRAFT to `status`. A draft is published only through review
   * (Work 30): submit and approve (Works 29/28) — the generic route takes no DRAFT out — then
   * Module 03's generic route for the rest.
   */
  async function productIn(status: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const id = await createProduct(overrides);
    if (status === 'DRAFT') return id;
    await request(ctx.server).post(`/admin/catalog/review/${id}/submit`).set(...auth(admin.accessToken)).expect(200);
    await request(ctx.server).post(`/admin/catalog/review/${id}/approve`).set(...auth(admin.accessToken)).expect(200);
    const rest: Record<string, string[]> = { ACTIVE: [], DEPRECATED: ['DEPRECATED'], DELISTED: ['DELISTED'] };
    for (const step of rest[status]) {
      await changeStatus(id, step).expect(200);
    }
    return id;
  }

  // ===========================================================================================
  // 1. The list is Module 03's rows in the state asked for
  // ===========================================================================================

  describe('listing', () => {
    it('lists DRAFT by default, oldest first, with Module 03’s projection of each product', async () => {
      const first = await createProduct({ genericName: 'Paracetamol', nameEn: 'Paracetamol 500 mg' });
      const second = await createProduct();
      await productIn('ACTIVE');
      // Make the order independent of clock resolution: the second product is older.
      await ctx.prisma.product.update({ where: { id: second }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } });

      const view = await read();
      expect(view).toMatchObject({ total: 2, page: 1, size: 20 });
      expect(view.items.map((i) => i.id)).toEqual([second, first]);
      expect(view.items[1]).toEqual({
        id: first,
        type: 'MEDICINE',
        genericName: 'Paracetamol',
        brandName: null,
        nameAm: null,
        nameEn: 'Paracetamol 500 mg',
        dosageForm: 'TABLET',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        controlledSchedule: 'NONE',
        onlineSaleProhibited: false,
        manufacturerName: 'Acme Pharma',
        price: null,
        status: 'DRAFT',
        // Work 29 added DRAFT → PENDING_REVIEW; Work 30 closed DRAFT → ACTIVE.
        allowedTransitions: ['PENDING_REVIEW'],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('lists each status Module 03 defines, with the transitions its state machine allows', async () => {
      const ids: Record<string, string> = {};
      for (const status of ['DRAFT', 'ACTIVE', 'DEPRECATED', 'DELISTED']) {
        ids[status] = await productIn(status);
      }
      const expected: Record<string, string[]> = {
        // Work 29 added DRAFT → PENDING_REVIEW, Work 30 closed DRAFT → ACTIVE; Work 28 added PENDING_REVIEW → ACTIVE.
        DRAFT: ['PENDING_REVIEW'],
        PENDING_REVIEW: ['ACTIVE'],
        ACTIVE: ['DEPRECATED', 'DELISTED'],
        DEPRECATED: ['ACTIVE', 'DELISTED'],
        DELISTED: ['DRAFT'],
      };
      for (const status of STATUSES) {
        const view = await read({ status });
        if (status === 'PENDING_REVIEW') {
          // Nothing was submitted for review in this test (Work 29's route) — accepted as a filter, and empty.
          expect(view).toEqual({ items: [], total: 0, page: 1, size: 20 });
          continue;
        }
        expect(view.items.map((i) => [i.id, i.status, i.allowedTransitions])).toEqual([
          [ids[status], status, expected[status]],
        ]);
      }
    });

    it('excludes soft-deleted products, as every Module 03 read does', async () => {
      const kept = await createProduct();
      const deleted = await createProduct();
      await ctx.prisma.product.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
      const view = await read();
      expect(view.items.map((i) => i.id)).toEqual([kept]);
      expect(view.total).toBe(1);
    });

    it('filters by type and by a case-insensitive name substring, as the public search does', async () => {
      const amox = await createProduct({ genericName: 'Amoxicillin', nameEn: 'Amoxil' });
      const brand = await createProduct({ genericName: 'Ibuprofen', brandName: 'AMOXI-Pain' });
      const health = await createProduct({
        type: 'HEALTH_PRODUCT',
        genericName: undefined,
        dosageForm: undefined,
        strengthValue: undefined,
        strengthUnit: undefined,
        rxClassification: undefined,
        nameEn: 'Amox hand cream',
      });

      expect((await read({ q: 'amox' })).items.map((i) => i.id).sort()).toEqual([amox, brand, health].sort());
      expect((await read({ q: 'amox', type: 'MEDICINE' })).items.map((i) => i.id).sort()).toEqual([amox, brand].sort());
      expect((await read({ type: 'HEALTH_PRODUCT' })).items.map((i) => i.id)).toEqual([health]);
      expect((await read({ q: 'nothing-matches' })).total).toBe(0);
    });

    it('pages with a stable order and reports the full total', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = await createProduct();
        await ctx.prisma.product.update({ where: { id }, data: { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) } });
        ids.push(id);
      }
      const p1 = await read({ size: 2, page: 1 });
      const p2 = await read({ size: 2, page: 2 });
      const p3 = await read({ size: 2, page: 3 });
      expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
      expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toEqual(ids);
      expect((await read({ size: 2, page: 4 })).items).toEqual([]);
    });
  });

  // ===========================================================================================
  // 2. The decision stays on Module 03's route — and the list tells the truth about it
  // ===========================================================================================

  describe('the moderation lifecycle is Module 03’s', () => {
    it('every allowedTransitions entry is accepted by Module 03’s status route, and nothing else is', async () => {
      for (const from of ['DRAFT', 'ACTIVE', 'DEPRECATED', 'DELISTED']) {
        for (const to of TARGETS) {
          const id = await productIn(from);
          const row = (await read({ status: from, size: 100 })).items.find((i) => i.id === id)!;
          const res = await changeStatus(id, to);
          const allowed = row.allowedTransitions.includes(to);
          expect({ from, to, status: res.status }).toEqual({ from, to, status: allowed ? 200 : 422 });
          if (!allowed) {
            expect(errorOf(res).code).toBe(ErrorCode.INVALID_PRODUCT_STATUS_TRANSITION);
          }
        }
      }
    });

    it('a decision moves the product between lists, with exactly one audit entry — Module 03’s', async () => {
      // A DRAFT has no decision on this route since Work 30 (it leaves only through review), so the
      // decision here is an ACTIVE product's: deprecation.
      const id = await productIn('ACTIVE');
      const before = new Set((await ctx.prisma.auditLog.findMany({ select: { id: true } })).map((a) => a.id));

      await changeStatus(id, 'DEPRECATED').expect(200);

      expect((await read({ status: 'ACTIVE' })).items.map((i) => i.id)).toEqual([]);
      expect((await read({ status: 'DEPRECATED' })).items.map((i) => i.id)).toEqual([id]);
      const written = (await ctx.prisma.auditLog.findMany()).filter((a) => !before.has(a.id));
      expect(written.map((a) => [a.action, a.resourceType, a.resourceId, a.actorUserId])).toEqual([
        ['PRODUCT_STATUS_CHANGED', 'Product', id, admin.userId],
      ]);
    });

    it('a refused decision writes no audit entry and leaves the product on its list', async () => {
      const id = await createProduct();
      const before = await ctx.prisma.auditLog.count();
      await changeStatus(id, 'DELISTED').expect(422);
      expect(await ctx.prisma.auditLog.count()).toBe(before);
      expect((await read()).items.map((i) => i.id)).toEqual([id]);
    });

    it('a replayed decision is refused by Module 03 the second time, and audited once', async () => {
      const id = await productIn('ACTIVE');
      const before = await ctx.prisma.auditLog.count();
      await changeStatus(id, 'DEPRECATED').expect(200);
      const replay = await changeStatus(id, 'DEPRECATED').expect(422);
      expect(errorOf(replay).code).toBe(ErrorCode.INVALID_PRODUCT_STATUS_TRANSITION);
      expect(await ctx.prisma.auditLog.count()).toBe(before + 1);
    });
  });

  // ===========================================================================================
  // 3. Validation, authorization, privacy, read-only-ness, routes
  // ===========================================================================================

  describe('validation', () => {
    it.each([
      ['an unknown status', { status: 'APPROVED' }],
      ['an unknown type', { type: 'DEVICE' }],
      ['page 0', { page: 0 }],
      ['a non-numeric page', { page: 'two' }],
      ['an oversized page size', { size: 101 }],
      ['an empty q', { q: '' }],
      ['an overlong q', { q: 'x'.repeat(101) }],
      ['an unknown parameter', { sort: 'newest' }],
      ['a client-supplied actor', { actorUserId: randomUUID() }],
    ])('rejects %s with 400', async (_label, query) => {
      const res = await list(admin.accessToken, query).expect(400);
      expect(errorOf(res).code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('authorization', () => {
    it('serves ADMIN and SUPER_ADMIN', async () => {
      const superAdmin = await createUserWithRole(ctx, 'SUPER_ADMIN');
      await list(admin.accessToken).expect(200);
      await list(superAdmin.accessToken).expect(200);
    });

    it.each(['FINANCE_OFFICER', 'CUSTOMER_SUPPORT', 'CUSTOMER', 'DRIVER', 'PHARMACY_OWNER'])(
      'refuses %s',
      async (role) => {
        // PHARMACY_OWNER holds `catalog:manage:org`, which is not `catalog:manage:any`.
        const caller = await createUserWithRole(ctx, role);
        const res = await list(caller.accessToken).expect(403);
        expect(errorOf(res).code).toBe(ErrorCode.FORBIDDEN);
      },
    );

    it('refuses an unauthenticated caller', async () => {
      const res = await request(ctx.server).get(REVIEW).expect(401);
      expect(errorOf(res).code).toBe(ErrorCode.UNAUTHENTICATED);
    });

    it('reuses Module 03’s curator key, still granted to ADMIN alone, and adds no catalogue key', async () => {
      const permission = await ctx.prisma.permission.findUniqueOrThrow({ where: { key: 'catalog:manage:any' } });
      const holders = await ctx.prisma.rolePermission.findMany({
        where: { permissionId: permission.id },
        include: { role: { select: { key: true } } },
      });
      expect(holders.map((h) => h.role.key)).toEqual(['ADMIN']);
      const catalogKeys = await ctx.prisma.permission.findMany({ where: { resource: 'catalog' }, orderBy: { key: 'asc' } });
      expect(catalogKeys.map((p) => p.key)).toEqual(['catalog:manage:any', 'catalog:manage:org', 'catalog:read:any']);
    });
  });

  describe('privacy', () => {
    it('carries no creator, contact detail, credential, description or deletion marker in the raw body', async () => {
      await createProduct({ descriptionEn: 'Secret description text', warnings: 'Secret warning text' });
      const raw = JSON.stringify((await list(admin.accessToken).expect(200)).body);
      for (const forbidden of [
        'createdBy', admin.userId, admin.phone, 'passwordHash', 'accessToken', 'faydaId', 'storageRef',
        'descriptionEn', 'descriptionAm', 'warnings', 'Secret', 'deletedAt', 'categories',
      ]) {
        expect({ forbidden, found: raw.includes(forbidden) }).toEqual({ forbidden, found: false });
      }
    });
  });

  describe('read-only', () => {
    it('appends no audit entry and changes no product', async () => {
      await createProduct();
      await productIn('ACTIVE');
      const before = {
        audits: await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } }),
        products: await ctx.prisma.product.findMany({ orderBy: { id: 'asc' } }),
      };
      await list(admin.accessToken).expect(200);
      await list(admin.accessToken, { status: 'ACTIVE', q: 'Product' }).expect(200);
      expect(await ctx.prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).toEqual(before.audits);
      expect(await ctx.prisma.product.findMany({ orderBy: { id: 'asc' } })).toEqual(before.products);
    });
  });

  describe('routes', () => {
    // Work 28 added POST review/:productId/approve (PENDING_REVIEW only; admin-catalog-approval.e2e-spec.ts).
    it('adds nothing but GET /admin/catalog/review (and Work 28’s approve) — no detail, reject or write route', async () => {
      const id = await createProduct();
      for (const [method, path] of [
        ['get', `/admin/catalog/review/${id}`],
        ['post', '/admin/catalog/review'],
        ['post', `/admin/catalog/review/${id}/reject`],
        ['patch', `/admin/catalog/review/${id}`],
        ['delete', `/admin/catalog/review/${id}`],
        ['get', '/admin/catalog/products'],
        ['get', '/admin/product-proposals'],
        ['get', '/admin/products'],
        ['get', '/admin/inventory'],
      ] as const) {
        const res = await request(ctx.server)[method](path).set(...auth(admin.accessToken)).send({});
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
    });

    it('leaves Module 03’s own admin routes answering as before: detail, and 404 for an unknown product', async () => {
      const id = await createProduct({ descriptionEn: 'Full record' });
      const detail = body(
        await request(ctx.server).get(`/admin/catalog/products/${id}`).set(...auth(admin.accessToken)).expect(200),
      );
      expect(detail).toMatchObject({ id, status: 'DRAFT', descriptionEn: 'Full record' });
      const missing = await request(ctx.server)
        .get(`/admin/catalog/products/${randomUUID()}`)
        .set(...auth(admin.accessToken))
        .expect(404);
      expect(errorOf(missing).code).toBe(ErrorCode.NOT_FOUND);
      await request(ctx.server).get('/admin/catalog/categories').set(...auth(admin.accessToken)).expect(200);
      await request(ctx.server).get('/admin/catalog/manufacturers').set(...auth(admin.accessToken)).expect(200);
    });
  });

  describe('boundaries', () => {
    const adminRoot = join(__dirname, '..', '..', 'src', 'modules', 'admin');
    /** Every Work 09 source file: the query, controller, DTOs and response. */
    const work09 = (): string[] => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (/catalog-review\.[a-z.]*ts$/.test(name)) files.push(full);
        }
      };
      walk(adminRoot);
      return files;
    };

    it('finds the Work 09 files it checks', () => {
      expect(work09().map((f) => f.replace(/^.*[\\/]admin[\\/]/, '').replace(/\\/g, '/')).sort()).toEqual([
        'application/admin-catalog-review.spec.ts',
        'application/queries/list-catalog-review.query.ts',
        'interface/controllers/admin-catalog-review.controller.ts',
        'interface/dtos/catalog-review.dto.ts',
        'interface/dtos/catalog-review.response.ts',
      ]);
    });

    it('Work 09 touches no Module 03/04 table, persistence, repository, entity or infrastructure', () => {
      for (const file of work09()) {
        const source = readFileSync(file, 'utf8');
        for (const forbidden of [
          'PrismaService',
          'prisma.',
          '@prisma/client',
          '$queryRaw',
          '$executeRaw',
          // Module 03
          'PRODUCT_REPOSITORY',
          'CATEGORY_REPOSITORY',
          'ProductStatusPolicy',
          'catalog/domain/',
          'catalog/infrastructure/',
          'catalog/application/commands/',
          'catalog/application/queries/',
          // Module 04
          'pharmacy-inventory/',
          'LISTING_REPOSITORY',
          'PHARMACY_REPOSITORY',
          'BRANCH_REPOSITORY',
        ]) {
          expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({ file, forbidden, found: false });
        }
      }
    });

    it('Work 09 reaches Module 03 only through its admin read port', () => {
      const imports = new Set<string>();
      for (const file of work09()) {
        for (const m of readFileSync(file, 'utf8').matchAll(/from '([^']*(?:catalog|pharmacy-inventory)\/[^']*)'/g)) {
          imports.add(m[1].replace(/^(\.\.\/)+/, ''));
        }
      }
      expect([...imports]).toEqual(['catalog/application/ports/inbound/catalog-admin-read.port']);
    });
  });
});
