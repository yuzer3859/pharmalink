import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { CatalogReviewSummaryView, ICatalogReviewSummaryReadPort } from '../../catalog/application/ports/inbound/catalog-review-summary-read.port';
import { PrismaCatalogReviewSummaryReadAdapter } from '../../catalog/infrastructure/persistence/prisma-catalog-review-summary-read.adapter';
import { AdminCatalogSummaryController } from '../interface/controllers/admin-catalog-summary.controller';
import { toCatalogReviewSummaryResponse } from '../interface/dtos/catalog-review-summary.response';
import { ageSecondsBetween, GetCatalogReviewSummaryQuery } from './queries/get-catalog-review-summary.query';

const empty = (): CatalogReviewSummaryView => ({ pendingReviewCount: 0, pendingWithoutRecordedSubmission: 0, oldestPendingSubmittedAt: null, approvals: 0, rejections: 0, resubmissions: 0 });

describe('Admin catalogue review summary (application)', () => {
  const summary = async (view: CatalogReviewSummaryView) => {
    const port: ICatalogReviewSummaryReadPort = { summarizeReview: async () => view };
    return toCatalogReviewSummaryResponse(await new GetCatalogReviewSummaryQuery(port).execute());
  };

  it('an empty queue and no decisions: every field present, zero counts, null timestamp and age', async () => {
    const s = await summary(empty());
    expect(s).toEqual({
      generatedAt: expect.any(String),
      queue: { pendingReviewCount: 0, pendingWithoutRecordedSubmission: 0, oldestPendingSubmittedAt: null, oldestPendingAgeSeconds: null },
      lifetimeTransitions: { approvals: 0, rejections: 0, resubmissions: 0 },
    });
  });

  it('reports Module 03’s counts as given, and the oldest wait’s age in whole seconds to generatedAt', async () => {
    const oldest = new Date(Date.now() - 3_725_400);
    const s = await summary({ pendingReviewCount: 4, pendingWithoutRecordedSubmission: 1, oldestPendingSubmittedAt: oldest, approvals: 7, rejections: 3, resubmissions: 2 });
    expect(s.queue).toEqual({
      pendingReviewCount: 4,
      pendingWithoutRecordedSubmission: 1,
      oldestPendingSubmittedAt: oldest.toISOString(),
      oldestPendingAgeSeconds: Math.floor((Date.parse(s.generatedAt) - +oldest) / 1000),
    });
    expect(s.queue.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3_725);
    expect(s.lifetimeTransitions).toEqual({ approvals: 7, rejections: 3, resubmissions: 2 });
  });

  it('age is never negative and null without a timestamp', () => {
    const now = new Date('2026-10-12T12:00:00.000Z');
    expect(ageSecondsBetween(new Date('2026-10-12T11:59:58.900Z'), now)).toBe(1);
    expect(ageSecondsBetween(new Date('2026-10-12T12:00:05.000Z'), now)).toBe(0); // clock skew
    expect(ageSecondsBetween(null, now)).toBeNull();
  });

  it('aggregates only: exactly the approved fields; no id, actor, reason or audit detail', async () => {
    const s = await summary({ ...empty(), pendingReviewCount: 1, oldestPendingSubmittedAt: new Date() });
    expect(Object.keys(s)).toEqual(['generatedAt', 'queue', 'lifetimeTransitions']);
    expect(Object.keys(s.queue)).toEqual(['pendingReviewCount', 'pendingWithoutRecordedSubmission', 'oldestPendingSubmittedAt', 'oldestPendingAgeSeconds']);
    expect(Object.keys(s.lifetimeTransitions)).toEqual(['approvals', 'rejections', 'resubmissions']);
    expect(JSON.stringify(s)).not.toMatch(/productId|"id"|actor|reason|hash|"ip"|context/i);
  });

  describe('Module 03 adapter: database-side aggregates in one snapshot', () => {
    function stubbed(queue: object, decisions: object) {
      const queries: Prisma.Sql[] = [];
      let options: unknown;
      let transactions = 0;
      const prisma = {
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
          queries.push(Prisma.sql(strings, ...values));
          return { raw: queries.length };
        },
        $transaction: async (ops: unknown[], o: unknown) => {
          transactions++;
          options = o;
          expect(ops).toEqual([{ raw: 1 }, { raw: 2 }]);
          return [[queue], [decisions]];
        },
      } as unknown as PrismaService;
      return { adapter: new PrismaCatalogReviewSummaryReadAdapter(prisma), queries, get options() { return options; }, get transactions() { return transactions; } };
    }
    const text = (s: Prisma.Sql) => s.text.replace(/\s+/g, ' ');

    it('both statements in one REPEATABLE READ transaction; bigint counts become numbers', async () => {
      const oldest = new Date('2026-10-10T08:00:00Z');
      const t = stubbed({ pending: 3n, unrecorded: 1n, oldest }, { approvals: 5n, rejections: 2n, resubmissions: 1n });
      expect(await t.adapter.summarizeReview()).toEqual({ pendingReviewCount: 3, pendingWithoutRecordedSubmission: 1, oldestPendingSubmittedAt: oldest, approvals: 5, rejections: 2, resubmissions: 1 });
      expect(t.transactions).toBe(1);
      expect(t.options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      for (const q of t.queries) expect(text(q)).toMatch(/^ ?SELECT /);
      for (const q of t.queries) expect(text(q)).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER)\b/i);
    });

    it('queue: live PENDING_REVIEW products; per product the LATEST entry into PENDING_REVIEW (so a resubmission resets the wait); the earliest of those', () => {
      const t = stubbed({}, {});
      void t.adapter.summarizeReview().catch(() => undefined);
      const q = text(t.queries[0]);
      expect(q).toContain('MAX(a."createdAt")');
      expect(q).toContain('MIN(w."waitingSince")');
      expect(q).toContain('a."resourceId" = p."id"');
      expect(q).toContain(`a."context" ->> 'to' = $`);
      expect(q).toContain('p."deletedAt" IS NULL');
      expect(q).toContain('COUNT(*) FILTER (WHERE w."waitingSince" IS NULL)');
      expect(t.queries[0].values).toEqual(['PRODUCT_STATUS_CHANGED', 'Product', 'PENDING_REVIEW', 'PENDING_REVIEW']);
    });

    it('decisions: exact from/to pairs only — approvals PENDING_REVIEW→ACTIVE, rejections PENDING_REVIEW→REJECTED, resubmissions REJECTED→PENDING_REVIEW; Module 03’s action and resource type', () => {
      const t = stubbed({}, {});
      void t.adapter.summarizeReview().catch(() => undefined);
      const q = t.queries[1];
      expect(text(q).match(/FILTER \(WHERE a\."context" ->> 'from' = \$\d+ AND a\."context" ->> 'to' = \$\d+\)/g)).toHaveLength(3);
      expect(q.values).toEqual(['PENDING_REVIEW', 'ACTIVE', 'PENDING_REVIEW', 'REJECTED', 'REJECTED', 'PENDING_REVIEW', 'PRODUCT_STATUS_CHANGED', 'Product']);
    });
  });

  describe('architecture', () => {
    it('audit_logs is read only by the shared audit adapter and this Module 03 adapter; Module 16 never touches the table', () => {
      const src = join(__dirname, '..', '..', '..');
      const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') && !n.endsWith('.spec.ts') && files.push(join(d, n))));
      walk(src);
      const readers = files
        .filter((f) => /\.auditLog\.(findMany|findFirst|findUnique|count|groupBy|aggregate)|"audit_logs"/.test(readFileSync(f, 'utf8')))
        .map((f) => f.replace(/\\/g, '/').split('/src/')[1])
        .sort();
      expect(readers).toEqual([
        'modules/catalog/infrastructure/persistence/prisma-catalog-review-summary-read.adapter.ts',
        'shared/audit/audit.service.ts',
        'shared/audit/prisma-audit-read.adapter.ts',
      ]);
    });
  });

  describe('authorization', () => {
    it('GET summary under admin/catalog/review, catalog:manage:any; ADMIN and SUPER_ADMIN only; no new permission', () => {
      const handler = AdminCatalogSummaryController.prototype.getSummary;
      expect(Reflect.getMetadata('path', AdminCatalogSummaryController)).toBe('admin/catalog/review');
      expect(Reflect.getMetadata('path', handler)).toBe('summary');
      expect(Reflect.getMetadata('method', handler)).toBe(0); // GET
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['catalog:manage:any']);
      expect(Object.getOwnPropertyNames(AdminCatalogSummaryController.prototype).filter((m) => m !== 'constructor')).toEqual(['getSummary']);
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'catalog:manage:any') }).toEqual({ role, ok: role === 'ADMIN' || role === 'SUPER_ADMIN' });
      }
    });
  });
});
