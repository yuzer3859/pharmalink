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
import { CatalogReviewSubmissionPortAdapter } from '../../catalog/application/ports/inbound/catalog-review-submission.port';
import { IUnitOfWork } from '../../catalog/application/ports/unit-of-work.port';
import { Product, ProductProps } from '../../catalog/domain/entities/product.entity';
import { ControlledSchedule, ProductStatus, ProductType, RxClassification, StorageRequirement } from '../../catalog/domain/enums';
import { CatalogErrors } from '../../catalog/domain/errors';
import { ICategoryRepository } from '../../catalog/domain/repositories/category.repository';
import { IProductRepository } from '../../catalog/domain/repositories/product.repository';
import { ProductStatusPolicy } from '../../catalog/domain/services/product-status-policy';
import { AdminCatalogSubmissionController } from '../interface/controllers/admin-catalog-submission.controller';
import { toApprovedProductResponse } from '../interface/dtos/catalog-approval.response';
import { ApproveCatalogProductCommand } from './commands/approve-catalog-product.command';
import { SubmitCatalogProductCommand } from './commands/submit-catalog-product.command';

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

const CURATOR = 'curator-user-1';
const props = (status: ProductStatus, over: Partial<ProductProps> = {}): ProductProps => ({
  id: `p-${status.toLowerCase()}`,
  type: ProductType.MEDICINE,
  genericName: 'Metformin',
  brandName: 'Glucophage',
  manufacturerId: 'mfr-1',
  dosageForm: 'tablet',
  strengthValue: 850,
  strengthUnit: 'mg',
  packSize: '30',
  atcCode: 'A10BA02',
  rxClassification: RxClassification.RX,
  controlledSchedule: ControlledSchedule.NONE,
  onlineSaleProhibited: false,
  storageRequirement: StorageRequirement.AMBIENT,
  equivalenceGroupId: null,
  nameAm: null,
  nameEn: 'Metformin 850mg',
  descriptionAm: null,
  descriptionEn: 'Antidiabetic',
  warnings: null,
  price: 3_200,
  status,
  createdBy: 'creator-secret-id',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  deletedAt: null,
  ...over,
});

describe('Admin catalogue review submission (application)', () => {
  let products: Products;
  let audits: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let submit: SubmitCatalogProductCommand;
  let approve: ApproveCatalogProductCommand;

  beforeEach(() => {
    products = new Products();
    audits = [];
    events = [];
    const categories = { findManyByIds: async () => [] } as unknown as ICategoryRepository;
    const uow: IUnitOfWork = { run: (work) => work(undefined) };
    const audit = { record: async (e: Record<string, unknown>) => (audits.push(e), { id: 'a', hash: 'h' }) } as unknown as AuditService;
    const outbox = { write: async (e: Record<string, unknown>) => void events.push(e) } as unknown as OutboxService;
    const status = new ChangeProductStatusCommand(products as unknown as IProductRepository, categories, uow, audit, outbox);
    submit = new SubmitCatalogProductCommand(new CatalogReviewSubmissionPortAdapter(status));
    approve = new ApproveCatalogProductCommand(new CatalogReviewApprovalPortAdapter(status));
  });

  const seed = (status: ProductStatus, over: Partial<ProductProps> = {}) => {
    const p = props(status, over);
    products.rows.set(p.id, p);
    return p;
  };
  const doSubmit = (productId: string) => submit.execute({ actorUserId: CURATOR, productId });
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };

  it('the lifecycle gains exactly DRAFT → PENDING_REVIEW; DRAFT → ACTIVE and PENDING_REVIEW → ACTIVE are unchanged', () => {
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.DRAFT, ProductStatus.PENDING_REVIEW)).toBe(true);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.DRAFT, ProductStatus.ACTIVE)).toBe(true);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE)).toBe(true);
    for (const from of [ProductStatus.ACTIVE, ProductStatus.DEPRECATED, ProductStatus.DELISTED, ProductStatus.PENDING_REVIEW]) {
      expect({ from, legal: ProductStatusPolicy.isLegalTransition(from, ProductStatus.PENDING_REVIEW) }).toEqual({ from, legal: false });
    }
  });

  it('submits a DRAFT product: exactly DRAFT → PENDING_REVIEW, every other field untouched', async () => {
    const before = seed(ProductStatus.DRAFT);
    const res = toApprovedProductResponse(await doSubmit(before.id));
    expect(res.status).toBe('PENDING_REVIEW');
    const after = products.rows.get(before.id)!;
    const strip = (p: ProductProps) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect([before.status, after.status]).toEqual([ProductStatus.DRAFT, ProductStatus.PENDING_REVIEW]);
    expect(strip(after)).toEqual(strip(before));
    expect(products.writes).toBe(1);
    expect(JSON.stringify(res)).not.toContain('creator-secret-id');
    expect(res).not.toHaveProperty('createdBy');
  });

  it('exactly one audit entry and one outbox event, both Module 03’s; Module 16 writes none', async () => {
    const p = seed(ProductStatus.DRAFT);
    await doSubmit(p.id);
    expect(audits).toEqual([
      { actorUserId: CURATOR, action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: p.id, context: { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'catalog.product.status_changed', aggregateType: 'Product', aggregateId: p.id, payload: { productId: p.id, from: 'DRAFT', to: 'PENDING_REVIEW', reason: null } });
    expect(Reflect.getMetadata('design:paramtypes', SubmitCatalogProductCommand)).toEqual([Object]); // the port only — no AuditService or OutboxService
  });

  it('unknown or soft-deleted product → 404; nothing written, audited or published', async () => {
    seed(ProductStatus.DRAFT, { id: 'gone', deletedAt: new Date() });
    expect(await outcome(doSubmit('missing'))).toBe('404 NOT_FOUND');
    expect(await outcome(doSubmit('gone'))).toBe('404 NOT_FOUND');
    expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
  });

  for (const status of [ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE, ProductStatus.DEPRECATED, ProductStatus.DELISTED]) {
    it(`${status} → 409 CONFLICT, unchanged, no audit or event`, async () => {
      const p = seed(status);
      expect(await outcome(doSubmit(p.id))).toBe('409 CONFLICT');
      expect(products.rows.get(p.id)).toEqual(p);
      expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
    });
  }

  it('concurrent submissions: one transition, one audit, one event; the rest 409 — refused by the guarded write', async () => {
    const p = seed(ProductStatus.DRAFT);
    const results = await Promise.all([1, 2, 3].map(() => outcome(doSubmit(p.id))));
    expect(results.sort()).toEqual(['409 CONFLICT', '409 CONFLICT', 'ok']);
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.PENDING_REVIEW);
    expect([products.writes, audits.length, events.length]).toEqual([1, 1, 1]);
  });

  it('the full review: submit then approve — DRAFT → PENDING_REVIEW → ACTIVE, two audit entries, two events', async () => {
    const p = seed(ProductStatus.DRAFT);
    await doSubmit(p.id);
    await approve.execute({ actorUserId: CURATOR, productId: p.id });
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.ACTIVE);
    expect(audits.map((a) => a.context)).toEqual([
      { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null },
      { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null },
    ]);
    expect(events.map((e) => (e.payload as { from: string; to: string }).to)).toEqual(['PENDING_REVIEW', 'ACTIVE']);
  });

  describe('authorization and architecture', () => {
    it('POST :productId/submit, catalog:manage:any; no body, so no target status can be chosen', () => {
      const handler = AdminCatalogSubmissionController.prototype.submitOne;
      expect(Reflect.getMetadata('path', AdminCatalogSubmissionController)).toBe('admin/catalog/review');
      expect(Reflect.getMetadata('path', handler)).toBe(':productId/submit');
      expect(Reflect.getMetadata('method', handler)).toBe(1); // POST
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['catalog:manage:any']);
      // The handler's parameters: the principal and the id — no @Body.
      const args = Reflect.getMetadata('__routeArguments__', AdminCatalogSubmissionController, 'submitOne') as Record<string, unknown>;
      expect(Object.keys(args).some((k) => k.startsWith('3:'))).toBe(false); // RouteParamtypes.BODY = 3
    });

    it('only catalogue curators submit — ADMIN and SUPER_ADMIN; pharmacy roles holding catalog:manage:org do not', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'catalog:manage:any') }).toEqual({ role, manage: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['catalog:manage:org'], 'catalog:manage:any')).toBe(false);
      expect(hasPermission(['catalog:read:any'], 'catalog:manage:any')).toBe(false);
    });

    it('Module 16 delegates: no Prisma, repository, entity, policy or status write of its own', () => {
      const root = join(__dirname, '..');
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') && !n.endsWith('.spec.ts') && files.push(join(d, n))));
      walk(root);
      const mine = files.filter((x) => /catalog-submission|submit-catalog-product/.test(x));
      expect(mine).toHaveLength(2);
      for (const f of mine) {
        const src = readFileSync(f, 'utf8');
        expect({ f, bad: /PrismaService|@prisma\/client|_REPOSITORY|ProductStatusPolicy|transitionStatus|catalog\/domain|catalog\/infrastructure|catalog\/application\/commands/.test(src) }).toEqual({ f, bad: false });
      }
    });
  });
});
