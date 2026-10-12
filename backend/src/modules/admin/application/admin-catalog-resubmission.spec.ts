import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { ChangeProductStatusCommand } from '../../catalog/application/commands/change-product-status.command';
import { CatalogReviewRejectionPortAdapter } from '../../catalog/application/ports/inbound/catalog-review-rejection.port';
import { CatalogReviewResubmissionPortAdapter } from '../../catalog/application/ports/inbound/catalog-review-resubmission.port';
import { IUnitOfWork } from '../../catalog/application/ports/unit-of-work.port';
import { Product, ProductProps } from '../../catalog/domain/entities/product.entity';
import { ControlledSchedule, ProductStatus, ProductType, RxClassification, StorageRequirement } from '../../catalog/domain/enums';
import { CatalogErrors } from '../../catalog/domain/errors';
import { ICategoryRepository } from '../../catalog/domain/repositories/category.repository';
import { IProductRepository } from '../../catalog/domain/repositories/product.repository';
import { ProductStatusPolicy } from '../../catalog/domain/services/product-status-policy';
import { ChangeProductStatusDto } from '../../catalog/interface/dtos/product.dto';
import { AdminCatalogResubmissionController } from '../interface/controllers/admin-catalog-resubmission.controller';
import { toApprovedProductResponse } from '../interface/dtos/catalog-approval.response';
import { RejectCatalogProductCommand } from './commands/reject-catalog-product.command';
import { ResubmitCatalogProductCommand } from './commands/resubmit-catalog-product.command';

/** `products` in memory, with the Prisma adapter's guarded-write semantics for `expectedStatus`. */
class Products implements Pick<IProductRepository, 'findById' | 'save' | 'categoryIdsFor'> {
  rows = new Map<string, ProductProps>();
  writes = 0;
  async findById(id: string) {
    await Promise.resolve();
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
  genericName: 'Losartan',
  brandName: 'Cozaar',
  manufacturerId: 'mfr-1',
  dosageForm: 'tablet',
  strengthValue: 50,
  strengthUnit: 'mg',
  packSize: '28',
  atcCode: 'C09CA01',
  rxClassification: RxClassification.RX,
  controlledSchedule: ControlledSchedule.NONE,
  onlineSaleProhibited: false,
  storageRequirement: StorageRequirement.AMBIENT,
  equivalenceGroupId: null,
  nameAm: null,
  nameEn: 'Losartan 50mg',
  descriptionAm: null,
  descriptionEn: 'Antihypertensive',
  warnings: null,
  price: 2_900,
  status,
  createdBy: 'creator-secret-id',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  deletedAt: null,
  ...over,
});

describe('Admin catalogue review resubmission (application)', () => {
  let products: Products;
  let audits: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let status: ChangeProductStatusCommand;
  let resubmit: ResubmitCatalogProductCommand;

  beforeEach(() => {
    products = new Products();
    audits = [];
    events = [];
    const categories = { findManyByIds: async () => [] } as unknown as ICategoryRepository;
    const uow: IUnitOfWork = { run: (work) => work(undefined) };
    const audit = { record: async (e: Record<string, unknown>) => (audits.push(e), { id: 'a', hash: 'h' }) } as unknown as AuditService;
    const outbox = { write: async (e: Record<string, unknown>) => void events.push(e) } as unknown as OutboxService;
    status = new ChangeProductStatusCommand(products as unknown as IProductRepository, categories, uow, audit, outbox);
    resubmit = new ResubmitCatalogProductCommand(new CatalogReviewResubmissionPortAdapter(status));
  });

  const seed = (s: ProductStatus, over: Partial<ProductProps> = {}) => {
    const p = props(s, over);
    products.rows.set(p.id, p);
    return p;
  };
  const doResubmit = (productId: string) => resubmit.execute({ actorUserId: CURATOR, productId });
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };

  it('the lifecycle gains exactly REJECTED → PENDING_REVIEW; REJECTED → ACTIVE and DRAFT → ACTIVE stay illegal; the rest unchanged', () => {
    const all = Object.values(ProductStatus);
    expect(all.filter((to) => ProductStatusPolicy.isLegalTransition(ProductStatus.REJECTED, to))).toEqual([ProductStatus.PENDING_REVIEW]);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.REJECTED, ProductStatus.ACTIVE)).toBe(false);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.DRAFT, ProductStatus.ACTIVE)).toBe(false);
    const legal = all.flatMap((from) => all.filter((to) => ProductStatusPolicy.isLegalTransition(from, to)).map((to) => `${from}->${to}`));
    expect(legal.sort()).toEqual(
      [
        'DRAFT->PENDING_REVIEW',
        'PENDING_REVIEW->ACTIVE',
        'PENDING_REVIEW->REJECTED',
        'ACTIVE->DEPRECATED',
        'ACTIVE->DELISTED',
        'DEPRECATED->ACTIVE',
        'DEPRECATED->DELISTED',
        'DELISTED->DRAFT',
        'REJECTED->PENDING_REVIEW',
      ].sort(),
    );
  });

  it('resubmits a REJECTED product: exactly REJECTED → PENDING_REVIEW, every other field untouched', async () => {
    const before = seed(ProductStatus.REJECTED);
    const res = toApprovedProductResponse(await doResubmit(before.id));
    expect(res.status).toBe('PENDING_REVIEW');
    const after = products.rows.get(before.id)!;
    const strip = (p: ProductProps) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect([before.status, after.status]).toEqual([ProductStatus.REJECTED, ProductStatus.PENDING_REVIEW]);
    expect(strip(after)).toEqual(strip(before));
    expect(res).not.toHaveProperty('createdBy');
  });

  it('exactly one audit entry and one outbox event — Module 03’s; Module 16 writes none', async () => {
    const p = seed(ProductStatus.REJECTED);
    await doResubmit(p.id);
    expect(audits).toEqual([
      { actorUserId: CURATOR, action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: p.id, context: { from: 'REJECTED', to: 'PENDING_REVIEW', reason: null } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'catalog.product.status_changed', aggregateId: p.id, payload: { productId: p.id, from: 'REJECTED', to: 'PENDING_REVIEW', reason: null } });
    expect(Reflect.getMetadata('design:paramtypes', ResubmitCatalogProductCommand)).toEqual([Object]); // the port only
  });

  it('unknown or soft-deleted product → 404; nothing written, audited or published', async () => {
    seed(ProductStatus.REJECTED, { id: 'gone', deletedAt: new Date() });
    expect(await outcome(doResubmit('missing'))).toBe('404 NOT_FOUND');
    expect(await outcome(doResubmit('gone'))).toBe('404 NOT_FOUND');
    expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
  });

  for (const s of [ProductStatus.DRAFT, ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE, ProductStatus.DEPRECATED, ProductStatus.DELISTED]) {
    it(`${s} → 422 INVALID_PRODUCT_STATUS_TRANSITION, unchanged, no audit or event${s === ProductStatus.DRAFT ? ' (though DRAFT → PENDING_REVIEW is legal — that is submission)' : ''}`, async () => {
      const p = seed(s);
      expect(await outcome(doResubmit(p.id))).toBe('422 INVALID_PRODUCT_STATUS_TRANSITION');
      expect(products.rows.get(p.id)).toEqual(p);
      expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
    });
  }

  it('concurrent resubmissions: one transition, one audit, one event; the losers write nothing', async () => {
    const p = seed(ProductStatus.REJECTED);
    const results = await Promise.all([1, 2, 3].map(() => outcome(doResubmit(p.id))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.PENDING_REVIEW);
    expect([products.writes, audits.length, events.length]).toEqual([1, 1, 1]);
  });

  it('the generic status route cannot resubmit: its request validation does not accept PENDING_REVIEW (nor REJECTED)', () => {
    for (const target of ['PENDING_REVIEW', 'REJECTED']) {
      expect(validateSync(plainToInstance(ChangeProductStatusDto, { status: target })).map((e) => e.property)).toEqual(['status']);
    }
  });

  it('rejection still requires its reason: rejecting the resubmitted product again without one is refused, with one it succeeds', async () => {
    const p = seed(ProductStatus.REJECTED);
    await doResubmit(p.id);
    const rejection = new RejectCatalogProductCommand(new CatalogReviewRejectionPortAdapter(status));
    expect(await outcome(rejection.execute({ actorUserId: CURATOR, productId: p.id, reason: '  ' }))).toBe('400 VALIDATION_ERROR');
    expect(await outcome(status.execute({ actorUserId: CURATOR, productId: p.id, status: 'REJECTED' }))).toBe('400 VALIDATION_ERROR');
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.PENDING_REVIEW);
    await rejection.execute({ actorUserId: CURATOR, productId: p.id, reason: 'Still missing the strength' });
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.REJECTED);
  });

  describe('authorization and architecture', () => {
    it('POST :productId/resubmit, catalog:manage:any (ADMIN and SUPER_ADMIN only); no body', () => {
      const handler = AdminCatalogResubmissionController.prototype.resubmitOne;
      expect(Reflect.getMetadata('path', AdminCatalogResubmissionController)).toBe('admin/catalog/review');
      expect(Reflect.getMetadata('path', handler)).toBe(':productId/resubmit');
      expect(Reflect.getMetadata('method', handler)).toBe(1); // POST
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['catalog:manage:any']);
      const args = Reflect.getMetadata('__routeArguments__', AdminCatalogResubmissionController, 'resubmitOne') as Record<string, unknown>;
      expect(Object.keys(args).some((k) => k.startsWith('3:'))).toBe(false); // RouteParamtypes.BODY = 3
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'catalog:manage:any') }).toEqual({ role, manage: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
    });

    it('Module 16 delegates: no Prisma, repository, entity, policy or status write of its own', () => {
      const root = join(__dirname, '..');
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') && !n.endsWith('.spec.ts') && files.push(join(d, n))));
      walk(root);
      const mine = files.filter((x) => /[\\/](admin-catalog-resubmission\.controller|resubmit-catalog-product\.command)\.ts$/.test(x));
      expect(mine).toHaveLength(2);
      for (const f of mine) {
        const src = readFileSync(f, 'utf8');
        expect({ f, bad: /PrismaService|@prisma\/client|_REPOSITORY|ProductStatusPolicy|transitionStatus|catalog\/domain|catalog\/infrastructure|catalog\/application\/commands/.test(src) }).toEqual({ f, bad: false });
      }
    });
  });
});
