import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { ChangeProductStatusCommand } from '../../catalog/application/commands/change-product-status.command';
import { CatalogReviewApprovalPortAdapter } from '../../catalog/application/ports/inbound/catalog-review-approval.port';
import { IUnitOfWork } from '../../catalog/application/ports/unit-of-work.port';
import { Product, ProductProps } from '../../catalog/domain/entities/product.entity';
import { ControlledSchedule, ProductStatus, ProductType, RxClassification, StorageRequirement } from '../../catalog/domain/enums';
import { CatalogErrors } from '../../catalog/domain/errors';
import { ICategoryRepository } from '../../catalog/domain/repositories/category.repository';
import { IProductRepository } from '../../catalog/domain/repositories/product.repository';
import { ProductStatusPolicy } from '../../catalog/domain/services/product-status-policy';
import { AdminCatalogApprovalController } from '../interface/controllers/admin-catalog-approval.controller';
import { AdminCatalogReviewController } from '../interface/controllers/admin-catalog-review.controller';
import { toApprovedProductResponse } from '../interface/dtos/catalog-approval.response';
import { ApproveCatalogProductCommand } from './commands/approve-catalog-product.command';

/** `products` in memory, with the Prisma adapter's guarded-write semantics for `expectedStatus`. */
class Products implements Pick<IProductRepository, 'findById' | 'save' | 'categoryIdsFor'> {
  rows = new Map<string, ProductProps>();
  writes = 0;
  async findById(id: string) {
    await Promise.resolve(); // a round-trip, so concurrent callers interleave
    const row = this.rows.get(id);
    return row ? Product.rehydrate({ ...row }) : null;
  }
  async save(product: Product, _tx?: unknown, expectedStatus?: ProductStatus) {
    await Promise.resolve();
    const props = product.toProps();
    const stored = this.rows.get(props.id)!;
    if (expectedStatus && stored.status !== expectedStatus) throw CatalogErrors.productNotInExpectedStatus(expectedStatus, stored.status);
    this.rows.set(props.id, { ...props });
    this.writes++;
  }
  async categoryIdsFor() {
    return [];
  }
}

const ADMIN = 'admin-user-1';
const props = (status: ProductStatus, over: Partial<ProductProps> = {}): ProductProps => ({
  id: `p-${status.toLowerCase()}`,
  type: ProductType.MEDICINE,
  genericName: 'Amoxicillin',
  brandName: 'Amoxil',
  manufacturerId: 'mfr-1',
  dosageForm: 'capsule',
  strengthValue: 500,
  strengthUnit: 'mg',
  packSize: '20',
  atcCode: 'J01CA04',
  rxClassification: RxClassification.RX,
  controlledSchedule: ControlledSchedule.NONE,
  onlineSaleProhibited: false,
  storageRequirement: StorageRequirement.AMBIENT,
  equivalenceGroupId: null,
  nameAm: null,
  nameEn: 'Amoxicillin 500mg',
  descriptionAm: null,
  descriptionEn: 'Antibiotic',
  warnings: null,
  price: 4_500,
  status,
  createdBy: 'curator-secret-id',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  deletedAt: null,
  ...over,
});

describe('Admin catalogue review approval (application)', () => {
  let products: Products;
  let audits: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let command: ApproveCatalogProductCommand;

  beforeEach(() => {
    products = new Products();
    audits = [];
    events = [];
    const categories = { findManyByIds: async () => [] } as unknown as ICategoryRepository;
    const uow: IUnitOfWork = { run: (work) => work(undefined) };
    const audit = { record: async (e: Record<string, unknown>) => (audits.push(e), { id: 'a', hash: 'h' }) } as unknown as AuditService;
    const outbox = { write: async (e: Record<string, unknown>) => void events.push(e) } as unknown as OutboxService;
    const status = new ChangeProductStatusCommand(products as unknown as IProductRepository, categories, uow, audit, outbox);
    command = new ApproveCatalogProductCommand(new CatalogReviewApprovalPortAdapter(status));
  });

  const seed = (status: ProductStatus, over: Partial<ProductProps> = {}) => {
    const p = props(status, over);
    products.rows.set(p.id, p);
    return p;
  };
  const approve = (productId: string) => command.execute({ actorUserId: ADMIN, productId });
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };

  it('PENDING_REVIEW → ACTIVE is now a legal Module 03 transition; nothing else changed in the state machine', () => {
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE)).toBe(true);
    for (const to of [ProductStatus.DRAFT, ProductStatus.DEPRECATED, ProductStatus.DELISTED, ProductStatus.PENDING_REVIEW]) {
      expect({ to, legal: ProductStatusPolicy.isLegalTransition(ProductStatus.PENDING_REVIEW, to) }).toEqual({ to, legal: false });
    }
    // Only DRAFT leads into PENDING_REVIEW — Work 29's submission (admin-catalog-submission.spec.ts).
    for (const from of Object.values(ProductStatus)) {
      expect({ from, legal: ProductStatusPolicy.isLegalTransition(from, ProductStatus.PENDING_REVIEW) }).toEqual({ from, legal: from === ProductStatus.DRAFT });
    }
    // Work 30: a draft is published only through review.
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.DRAFT, ProductStatus.ACTIVE)).toBe(false);
  });

  it('approves a pending product: exactly PENDING_REVIEW → ACTIVE, every other field untouched', async () => {
    const before = seed(ProductStatus.PENDING_REVIEW);
    const res = toApprovedProductResponse(await approve(before.id));
    expect(res.status).toBe('ACTIVE');
    const after = products.rows.get(before.id)!;
    const { status: s1, updatedAt: u1, ...restBefore } = before;
    const { status: s2, updatedAt: u2, ...restAfter } = after;
    expect([s1, s2]).toEqual([ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE]);
    expect(restAfter).toEqual(restBefore);
    expect(+u2).toBeGreaterThanOrEqual(+u1);
    expect(products.writes).toBe(1);
    // The response is Module 03's ProductDetailView — no createdBy.
    expect(JSON.stringify(res)).not.toContain('curator-secret-id');
    expect(res).not.toHaveProperty('createdBy');
    expect(res).not.toHaveProperty('deletedAt');
  });

  it('one audit entry and one outbox event, both Module 03’s; Module 16 writes none of its own', async () => {
    const p = seed(ProductStatus.PENDING_REVIEW);
    await approve(p.id);
    expect(audits).toEqual([
      { actorUserId: ADMIN, action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: p.id, context: { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'catalog.product.status_changed', aggregateType: 'Product', aggregateId: p.id, payload: { productId: p.id, from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null } });
    expect(JSON.stringify(audits)).not.toMatch(/supplier|price|phone|email|curator-secret-id/i);
    expect(Reflect.getMetadata('design:paramtypes', ApproveCatalogProductCommand)).toEqual([Object]); // the port only — no AuditService
  });

  it('unknown or soft-deleted product → 404; nothing written, nothing audited', async () => {
    seed(ProductStatus.PENDING_REVIEW, { id: 'gone', deletedAt: new Date() });
    expect(await outcome(approve('missing'))).toBe('404 NOT_FOUND');
    expect(await outcome(approve('gone'))).toBe('404 NOT_FOUND');
    expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
  });

  for (const status of [ProductStatus.DRAFT, ProductStatus.ACTIVE, ProductStatus.DEPRECATED, ProductStatus.DELISTED]) {
    it(`${status} → 409 CONFLICT, unchanged, not audited (even where → ACTIVE would be legal)`, async () => {
      const p = seed(status);
      expect(await outcome(approve(p.id))).toBe('409 CONFLICT');
      expect(products.rows.get(p.id)).toEqual(p);
      expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
    });
  }

  it('concurrent approvals: one transition, one audit, one event; the rest 409 — refused by the guarded write', async () => {
    const p = seed(ProductStatus.PENDING_REVIEW);
    const results = await Promise.all([1, 2, 3].map(() => outcome(approve(p.id))));
    expect(results.sort()).toEqual(['409 CONFLICT', '409 CONFLICT', 'ok']);
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.ACTIVE);
    expect([products.writes, audits.length, events.length]).toEqual([1, 1, 1]);
  });

  describe('authorization and architecture', () => {
    it('POST :productId/approve, catalog:manage:any; Work 09’s read controller unchanged (GET only)', () => {
      const handler = AdminCatalogApprovalController.prototype.approveOne;
      expect(Reflect.getMetadata('path', AdminCatalogApprovalController)).toBe('admin/catalog/review');
      expect(Reflect.getMetadata('path', handler)).toBe(':productId/approve');
      expect(Reflect.getMetadata('method', handler)).toBe(1); // POST
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['catalog:manage:any']);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminCatalogReviewController)).toEqual(['catalog:manage:any']);
      const reads = Object.getOwnPropertyNames(AdminCatalogReviewController.prototype).filter((m) => m !== 'constructor');
      expect(reads.map((m) => Reflect.getMetadata('method', AdminCatalogReviewController.prototype[m as 'list']))).toEqual([0]);
    });

    it('ADMIN and SUPER_ADMIN hold catalog:manage:any; every other role is refused (403); no new key', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'catalog:manage:any') }).toEqual({ role, manage: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['catalog:read:any'], 'catalog:manage:any')).toBe(false);
    });

    it('Module 16 delegates: no Prisma, repository, entity, policy or status write of its own', () => {
      const root = join(__dirname, '..');
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') && !n.endsWith('.spec.ts') && files.push(join(d, n))));
      walk(root);
      for (const f of files.filter((x) => /catalog-approval|approve-catalog-product/.test(x))) {
        const src = readFileSync(f, 'utf8');
        expect({ f, bad: /PrismaService|@prisma\/client|_REPOSITORY|ProductStatusPolicy|transitionStatus|catalog\/domain|catalog\/infrastructure|catalog\/application\/commands/.test(src) }).toEqual({ f, bad: false });
      }
    });
  });
});
