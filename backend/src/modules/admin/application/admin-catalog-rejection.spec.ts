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
import { IUnitOfWork } from '../../catalog/application/ports/unit-of-work.port';
import { Product, ProductProps } from '../../catalog/domain/entities/product.entity';
import { ControlledSchedule, ProductStatus, ProductType, RxClassification, StorageRequirement } from '../../catalog/domain/enums';
import { CatalogErrors } from '../../catalog/domain/errors';
import { ICategoryRepository } from '../../catalog/domain/repositories/category.repository';
import { IProductRepository } from '../../catalog/domain/repositories/product.repository';
import { ProductStatusPolicy } from '../../catalog/domain/services/product-status-policy';
import { ChangeProductStatusDto } from '../../catalog/interface/dtos/product.dto';
import { AdminCatalogRejectionController } from '../interface/controllers/admin-catalog-rejection.controller';
import { RejectCatalogProductDto } from '../interface/dtos/catalog-rejection.dto';
import { toApprovedProductResponse } from '../interface/dtos/catalog-approval.response';
import { RejectCatalogProductCommand } from './commands/reject-catalog-product.command';

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
const REASON = 'Duplicate of an existing listing';
const props = (status: ProductStatus, over: Partial<ProductProps> = {}): ProductProps => ({
  id: `p-${status.toLowerCase()}`,
  type: ProductType.MEDICINE,
  genericName: 'Ciprofloxacin',
  brandName: 'Cipro',
  manufacturerId: 'mfr-1',
  dosageForm: 'tablet',
  strengthValue: 500,
  strengthUnit: 'mg',
  packSize: '10',
  atcCode: 'J01MA02',
  rxClassification: RxClassification.RX,
  controlledSchedule: ControlledSchedule.NONE,
  onlineSaleProhibited: false,
  storageRequirement: StorageRequirement.AMBIENT,
  equivalenceGroupId: null,
  nameAm: null,
  nameEn: 'Ciprofloxacin 500mg',
  descriptionAm: null,
  descriptionEn: 'Antibiotic',
  warnings: null,
  price: 5_100,
  status,
  createdBy: 'creator-secret-id',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  deletedAt: null,
  ...over,
});
const dtoErrors = (plain: object) =>
  validateSync(plainToInstance(RejectCatalogProductDto, plain), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

describe('Admin catalogue review rejection (application)', () => {
  let products: Products;
  let audits: Array<Record<string, unknown>>;
  let events: Array<Record<string, unknown>>;
  let status: ChangeProductStatusCommand;
  let reject: RejectCatalogProductCommand;

  beforeEach(() => {
    products = new Products();
    audits = [];
    events = [];
    const categories = { findManyByIds: async () => [] } as unknown as ICategoryRepository;
    const uow: IUnitOfWork = { run: (work) => work(undefined) };
    const audit = { record: async (e: Record<string, unknown>) => (audits.push(e), { id: 'a', hash: 'h' }) } as unknown as AuditService;
    const outbox = { write: async (e: Record<string, unknown>) => void events.push(e) } as unknown as OutboxService;
    status = new ChangeProductStatusCommand(products as unknown as IProductRepository, categories, uow, audit, outbox);
    reject = new RejectCatalogProductCommand(new CatalogReviewRejectionPortAdapter(status));
  });

  const seed = (s: ProductStatus, over: Partial<ProductProps> = {}) => {
    const p = props(s, over);
    products.rows.set(p.id, p);
    return p;
  };
  const doReject = (productId: string, reason = REASON) => reject.execute({ actorUserId: CURATOR, productId, reason });
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };

  it('the lifecycle gains exactly PENDING_REVIEW → REJECTED; REJECTED leads only back to review (Work 32); Works 28–30 unchanged', () => {
    const all = Object.values(ProductStatus);
    expect(all.filter((from) => ProductStatusPolicy.isLegalTransition(from, ProductStatus.REJECTED))).toEqual([ProductStatus.PENDING_REVIEW]);
    expect(all.filter((to) => ProductStatusPolicy.isLegalTransition(ProductStatus.REJECTED, to))).toEqual([ProductStatus.PENDING_REVIEW]);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.DRAFT, ProductStatus.PENDING_REVIEW)).toBe(true);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.PENDING_REVIEW, ProductStatus.ACTIVE)).toBe(true);
    expect(ProductStatusPolicy.isLegalTransition(ProductStatus.DRAFT, ProductStatus.ACTIVE)).toBe(false);
  });

  it('rejects a PENDING_REVIEW product: exactly PENDING_REVIEW → REJECTED, every other field untouched, reason not in the response', async () => {
    const before = seed(ProductStatus.PENDING_REVIEW);
    const res = toApprovedProductResponse(await doReject(before.id, `  ${REASON}  `));
    expect(res.status).toBe('REJECTED');
    const after = products.rows.get(before.id)!;
    const strip = (p: ProductProps) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'status' && k !== 'updatedAt'));
    expect([before.status, after.status]).toEqual([ProductStatus.PENDING_REVIEW, ProductStatus.REJECTED]);
    expect(strip(after)).toEqual(strip(before));
    expect(JSON.stringify(res)).not.toContain(REASON);
    expect(res).not.toHaveProperty('createdBy');
  });

  it('exactly one audit entry and one outbox event — Module 03’s — with the trimmed reason', async () => {
    const p = seed(ProductStatus.PENDING_REVIEW);
    await doReject(p.id, `  ${REASON}  `);
    expect(audits).toEqual([
      { actorUserId: CURATOR, action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: p.id, context: { from: 'PENDING_REVIEW', to: 'REJECTED', reason: REASON } },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'catalog.product.status_changed', aggregateId: p.id, payload: { productId: p.id, from: 'PENDING_REVIEW', to: 'REJECTED', reason: REASON } });
    expect(Reflect.getMetadata('design:paramtypes', RejectCatalogProductCommand)).toEqual([Object]); // the port only
  });

  it('unknown or soft-deleted product → 404; nothing written, audited or published', async () => {
    seed(ProductStatus.PENDING_REVIEW, { id: 'gone', deletedAt: new Date() });
    expect(await outcome(doReject('missing'))).toBe('404 NOT_FOUND');
    expect(await outcome(doReject('gone'))).toBe('404 NOT_FOUND');
    expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
  });

  for (const s of [ProductStatus.DRAFT, ProductStatus.ACTIVE, ProductStatus.DEPRECATED, ProductStatus.DELISTED, ProductStatus.REJECTED]) {
    it(`${s} → 422 INVALID_PRODUCT_STATUS_TRANSITION, unchanged, no audit or event`, async () => {
      const p = seed(s);
      expect(await outcome(doReject(p.id))).toBe('422 INVALID_PRODUCT_STATUS_TRANSITION');
      expect(products.rows.get(p.id)).toEqual(p);
      expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
    });
  }

  it('concurrent rejections: one transition, one audit, one event; the losers write nothing', async () => {
    const p = seed(ProductStatus.PENDING_REVIEW);
    const results = await Promise.all([1, 2, 3].map(() => outcome(doReject(p.id))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(products.rows.get(p.id)!.status).toBe(ProductStatus.REJECTED);
    expect([products.writes, audits.length, events.length]).toEqual([1, 1, 1]);
  });

  describe('the reason', () => {
    it('request validation: missing, blank, whitespace-only, too short, too long and non-string reasons are refused; a valid one is trimmed', () => {
      expect(dtoErrors({})).toEqual(['reason']);
      expect(dtoErrors({ reason: '' })).toEqual(['reason']);
      expect(dtoErrors({ reason: '     ' })).toEqual(['reason']);
      expect(dtoErrors({ reason: ' ab ' })).toEqual(['reason']);
      expect(dtoErrors({ reason: 'x'.repeat(301) })).toEqual(['reason']);
      expect(dtoErrors({ reason: 42 })).toEqual(['reason']);
      expect(dtoErrors({ reason: REASON, status: 'ACTIVE' })).toEqual(['status']);
      expect(dtoErrors({ reason: `  ${'x'.repeat(300)}  ` })).toEqual([]);
      expect(plainToInstance(RejectCatalogProductDto, { reason: `  ${REASON} ` }).reason).toBe(REASON);
    });

    it('enforced centrally: the status command itself refuses a rejection without a valid reason — 400, nothing written', async () => {
      const p = seed(ProductStatus.PENDING_REVIEW);
      for (const reason of [undefined, '', '   ', 'ab', 'x'.repeat(301)]) {
        expect({ reason, r: await outcome(status.execute({ actorUserId: CURATOR, productId: p.id, status: 'REJECTED', reason })) }).toEqual({ reason, r: '400 VALIDATION_ERROR' });
      }
      expect(products.rows.get(p.id)!.status).toBe(ProductStatus.PENDING_REVIEW);
      expect([products.writes, audits.length, events.length]).toEqual([0, 0, 0]);
    });

    it('the generic status route cannot reject at all: its request validation does not accept REJECTED', () => {
      const errors = validateSync(plainToInstance(ChangeProductStatusDto, { status: 'REJECTED', reason: REASON }));
      expect(errors.map((e) => e.property)).toEqual(['status']);
    });

    it('other status changes keep their optional reason exactly as before', () => {
      expect(ProductStatusPolicy.reasonFor(ProductStatus.ACTIVE, undefined)).toBeNull();
      expect(ProductStatusPolicy.reasonFor(ProductStatus.DEPRECATED, ' kept as given ')).toBe(' kept as given ');
    });
  });

  describe('authorization and architecture', () => {
    it('POST :productId/reject, catalog:manage:any; ADMIN and SUPER_ADMIN only', () => {
      const handler = AdminCatalogRejectionController.prototype.rejectOne;
      expect(Reflect.getMetadata('path', AdminCatalogRejectionController)).toBe('admin/catalog/review');
      expect(Reflect.getMetadata('path', handler)).toBe(':productId/reject');
      expect(Reflect.getMetadata('method', handler)).toBe(1); // POST
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['catalog:manage:any']);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, manage: hasPermission(grants, 'catalog:manage:any') }).toEqual({ role, manage: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
    });

    it('Module 16 delegates: no Prisma, repository, entity, policy or status write of its own', () => {
      const root = join(__dirname, '..');
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') && !n.endsWith('.spec.ts') && files.push(join(d, n))));
      walk(root);
      const mine = files.filter((x) => /catalog-rejection|reject-catalog-product/.test(x));
      expect(mine).toHaveLength(3);
      for (const f of mine) {
        const src = readFileSync(f, 'utf8');
        expect({ f, bad: /PrismaService|@prisma\/client|_REPOSITORY|ProductStatusPolicy|transitionStatus|catalog\/domain|catalog\/infrastructure|catalog\/application\/commands/.test(src) }).toEqual({ f, bad: false });
      }
    });
  });
});
