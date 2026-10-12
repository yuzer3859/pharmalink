import 'reflect-metadata';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { AuditRecordView, AuditResourceTrailFilter, IAuditReadPort } from '../../../shared/audit/audit-read.port';
import { PrismaAuditReadAdapter } from '../../../shared/audit/prisma-audit-read.adapter';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { CatalogReviewHistoryPortAdapter } from '../../catalog/application/ports/inbound/catalog-review-history.port';
import { IProductRepository } from '../../catalog/domain/repositories/product.repository';
import { AdminCatalogHistoryController } from '../interface/controllers/admin-catalog-history.controller';
import { toCatalogReviewHistoryResponse } from '../interface/dtos/catalog-review-history.response';
import { GetCatalogReviewHistoryQuery } from './queries/get-catalog-review-history.query';

const P1 = '11111111-1111-4111-8111-111111111111';
const at = (iso: string) => new Date(`2026-10-1${iso}Z`);
const entry = (over: Partial<AuditRecordView> & { context: unknown; createdAt: Date }): AuditRecordView => ({
  id: `a-${Math.random()}`,
  actorUserId: 'curator-secret-user',
  action: 'PRODUCT_STATUS_CHANGED',
  resourceType: 'Product',
  resourceId: P1,
  ip: '203.0.113.5',
  prevHash: 'prev-hash-secret',
  hash: 'hash-secret',
  ...over,
});

/** The audit trail in memory: `trailOf` filters exactly and sorts oldest first, as the adapter's SQL does. */
class Audit implements IAuditReadPort {
  rows: AuditRecordView[] = [];
  filters: AuditResourceTrailFilter[] = [];
  writes = 0;
  async search(): Promise<never> {
    throw new Error('not used by the review history');
  }
  async findById(): Promise<never> {
    throw new Error('not used by the review history');
  }
  async trailOf(f: AuditResourceTrailFilter) {
    this.filters.push(f);
    return this.rows
      .filter((r) => r.action === f.action && r.resourceType === f.resourceType && r.resourceId === f.resourceId)
      .sort((a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id));
  }
}

describe('Admin catalogue review history (application)', () => {
  let audit: Audit;
  let live: Set<string>;
  let query: GetCatalogReviewHistoryQuery;

  beforeEach(() => {
    audit = new Audit();
    live = new Set([P1, 'p-other']);
    const products = {
      findById: async (id: string) => (live.has(id) ? { id, deletedAt: id === 'p-deleted' ? new Date() : null } : id === 'p-deleted' ? { id, deletedAt: new Date() } : null),
    } as unknown as IProductRepository;
    query = new GetCatalogReviewHistoryQuery(new CatalogReviewHistoryPortAdapter(products, audit));
  });

  const history = async (id = P1) => toCatalogReviewHistoryResponse(await query.execute(id));
  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };

  it('a product with no status changes: an empty history (not 404)', async () => {
    expect(await history()).toEqual({ productId: P1, history: [] });
    expect(audit.filters).toEqual([{ action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: P1 }]);
  });

  it('the complete review cycle, oldest first, with transitions, timestamps, and the reason on the rejection only', async () => {
    // Stored out of order on purpose.
    audit.rows.push(
      entry({ context: { from: 'PENDING_REVIEW', to: 'ACTIVE', reason: null }, createdAt: at('4T10:00:00.000') }),
      entry({ context: { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null }, createdAt: at('1T10:00:00.000') }),
      entry({ context: { from: 'REJECTED', to: 'PENDING_REVIEW', reason: null }, createdAt: at('3T10:00:00.000') }),
      entry({ context: { from: 'PENDING_REVIEW', to: 'REJECTED', reason: 'Strength missing' }, createdAt: at('2T10:00:00.000') }),
    );
    expect(await history()).toEqual({
      productId: P1,
      history: [
        { from: 'DRAFT', to: 'PENDING_REVIEW', occurredAt: '2026-10-11T10:00:00.000Z', reason: null },
        { from: 'PENDING_REVIEW', to: 'REJECTED', occurredAt: '2026-10-12T10:00:00.000Z', reason: 'Strength missing' },
        { from: 'REJECTED', to: 'PENDING_REVIEW', occurredAt: '2026-10-13T10:00:00.000Z', reason: null },
        { from: 'PENDING_REVIEW', to: 'ACTIVE', occurredAt: '2026-10-14T10:00:00.000Z', reason: null },
      ],
    });
  });

  it('a reason is returned for a rejection only: other changes’ free-text notes become null', async () => {
    audit.rows.push(
      entry({ context: { from: 'ACTIVE', to: 'DEPRECATED', reason: 'operator note, not a review record' }, createdAt: at('1T09:00:00.000') }),
      entry({ context: { from: 'DEPRECATED', to: 'DELISTED' }, createdAt: at('1T10:00:00.000') }),
    );
    expect((await history()).history.map((h) => [h.to, h.reason])).toEqual([['DEPRECATED', null], ['DELISTED', null]]);
  });

  it('other actions and other products are excluded; arbitrary context, actor, IP and hashes are never returned', async () => {
    audit.rows.push(
      entry({ context: { from: 'DRAFT', to: 'PENDING_REVIEW', reason: null, supplierSecret: 'S3CR3T', phone: '+251911000000' }, createdAt: at('1T10:00:00.000') }),
      entry({ action: 'PRODUCT_UPDATED', context: { changedFields: ['price'], price: 9999 }, createdAt: at('1T11:00:00.000') }),
      entry({ action: 'PRODUCT_CREATED', context: { from: 'X', to: 'Y' }, createdAt: at('1T09:00:00.000') }),
      entry({ resourceId: 'p-other', context: { from: 'PENDING_REVIEW', to: 'REJECTED', reason: 'other product' }, createdAt: at('1T12:00:00.000') }),
      entry({ resourceType: 'Category', context: { from: 'DRAFT', to: 'ACTIVE' }, createdAt: at('1T13:00:00.000') }),
    );
    const res = await history();
    expect(res.history).toEqual([{ from: 'DRAFT', to: 'PENDING_REVIEW', occurredAt: '2026-10-11T10:00:00.000Z', reason: null }]);
    expect(Object.keys(res)).toEqual(['productId', 'history']);
    expect(Object.keys(res.history[0])).toEqual(['from', 'to', 'occurredAt', 'reason']);
    expect(JSON.stringify(res)).not.toMatch(/S3CR3T|\+251|curator-secret-user|203\.0\.113|hash|changedFields|other product/);
  });

  it('an entry with an unexpected context shape is reported as recorded, never invented', async () => {
    audit.rows.push(entry({ context: null, createdAt: at('1T10:00:00.000') }), entry({ context: { from: 5, to: ['x'] }, createdAt: at('1T11:00:00.000') }));
    expect((await history()).history.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
      { from: null, to: null, reason: null },
      { from: null, to: null, reason: null },
    ]);
  });

  it('unknown or soft-deleted product → 404, without reading the trail', async () => {
    expect(await outcome(query.execute('p-missing'))).toBe('404 NOT_FOUND');
    expect(await outcome(query.execute('p-deleted'))).toBe('404 NOT_FOUND');
    expect(audit.filters).toEqual([]);
  });

  it('the shared adapter reads exactly this product’s status changes, oldest first, id as tiebreaker — one SELECT, nothing written', async () => {
    const calls: unknown[] = [];
    const prisma = {
      auditLog: {
        findMany: async (args: unknown) => (calls.push(args), []),
        create: () => {
          throw new Error('write attempted');
        },
      },
    } as unknown as PrismaService;
    await new PrismaAuditReadAdapter(prisma).trailOf({ action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: P1 });
    expect(calls).toEqual([{ where: { action: 'PRODUCT_STATUS_CHANGED', resourceType: 'Product', resourceId: P1 }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }]);
  });

  describe('authorization and shape', () => {
    it('GET :productId/history under admin/catalog/review, catalog:manage:any — not audit:read:any; the controller has no other route', () => {
      const handler = AdminCatalogHistoryController.prototype.historyOf;
      expect(Reflect.getMetadata('path', AdminCatalogHistoryController)).toBe('admin/catalog/review');
      expect(Reflect.getMetadata('path', handler)).toBe(':productId/history');
      expect(Reflect.getMetadata('method', handler)).toBe(0); // GET
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['catalog:manage:any']);
      expect(Object.getOwnPropertyNames(AdminCatalogHistoryController.prototype).filter((m) => m !== 'constructor')).toEqual(['historyOf']);
    });

    it('ADMIN and SUPER_ADMIN hold the key; every other role is refused (403); audit:read:any alone does not grant it', () => {
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'catalog:manage:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
      expect(hasPermission(['audit:read:any'], 'catalog:manage:any')).toBe(false);
      expect(hasPermission(['catalog:read:any'], 'catalog:manage:any')).toBe(false);
    });
  });
});
