import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { CodCollectionStatus, CodExceptionSummary, ICodExceptionSummaryReadPort } from '../../delivery/application/ports/inbound/cod-exception-summary-read.port';
import { toCodReconciliationView } from '../../delivery/application/queries/list-cod-collections.query';
import { CodCollectionRecord } from '../../delivery/domain/repositories/cod-collection.repository';
import { COD_DISCREPANCY_SQL, COD_OUTSTANDING_SQL } from '../../delivery/infrastructure/persistence/cod-collection.sql';
import { PrismaCodExceptionSummaryReadAdapter } from '../../delivery/infrastructure/persistence/prisma-cod-exception-summary-read.adapter';
import { AdminModule } from '../admin.module';
import { AdminCodOperationsController } from '../interface/controllers/admin-cod-operations.controller';
import { AdminCodSummaryController } from '../interface/controllers/admin-cod-summary.controller';
import { toCodExceptionSummaryResponse } from '../interface/dtos/cod-exception-summary.response';
import { GetCodExceptionSummaryQuery } from './queries/get-cod-exception-summary.query';

const NOW = new Date('2026-10-13T12:00:00Z');
type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  generatedAt: NOW, byStatus: null, total: 0n, outstandingCount: 0n, oldestOutstandingCollectedAt: null, oldestOutstandingAgeSeconds: null,
  discrepancyCount: 0n, reconciliationDiscrepancyCount: 0n, collectionsWithCorrectionsCount: 0n, collectionsWithOpenDisputesCount: 0n, openDisputeCount: 0n, ...over,
});

/** A Prisma double recording every `$queryRaw` statement as one `Prisma.Sql`. */
function fakePrisma(result: Row) {
  const statements: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => (statements.push(Prisma.sql(strings, ...values)), [result]),
  } as unknown as PrismaService;
  return { prisma, statements };
}

describe('Admin COD exception summary (application)', () => {
  describe('Module 08 adapter — mapping', () => {
    it('empty dataset: zeros everywhere, every status zero-filled in declaration order, oldest timestamp and age null', async () => {
      const { prisma } = fakePrisma(row());
      const s = await new PrismaCodExceptionSummaryReadAdapter(prisma).summarizeExceptions();
      expect(s).toEqual({
        generatedAt: NOW,
        collections: { total: 0, byStatus: { COLLECTED: 0, REMITTED: 0, RECONCILED: 0 }, outstandingCount: 0, oldestOutstandingCollectedAt: null, oldestOutstandingAgeSeconds: null },
        exceptions: { discrepancyCount: 0, reconciliationDiscrepancyCount: 0, collectionsWithCorrectionsCount: 0, collectionsWithOpenDisputesCount: 0, openDisputeCount: 0 },
      });
      expect(Object.keys(s.collections.byStatus)).toEqual(Object.values(CodCollectionStatus));
    });

    it('counts, missing statuses zero-filled, oldest outstanding and its age; bigints narrowed to numbers', async () => {
      const oldest = new Date('2026-10-12T12:00:00Z');
      const { prisma } = fakePrisma(row({
        byStatus: { COLLECTED: 3, RECONCILED: 2 }, total: 5n, outstandingCount: 3n, oldestOutstandingCollectedAt: oldest, oldestOutstandingAgeSeconds: 86_400n,
        discrepancyCount: 2n, reconciliationDiscrepancyCount: 1n, collectionsWithCorrectionsCount: 1n, collectionsWithOpenDisputesCount: 1n, openDisputeCount: 3n,
      }));
      const s = await new PrismaCodExceptionSummaryReadAdapter(prisma).summarizeExceptions();
      expect(s.collections).toEqual({ total: 5, byStatus: { COLLECTED: 3, REMITTED: 0, RECONCILED: 2 }, outstandingCount: 3, oldestOutstandingCollectedAt: oldest, oldestOutstandingAgeSeconds: 86_400 });
      // Collections with open disputes (1) and open dispute rows (3) are different numbers, kept apart.
      expect(s.exceptions).toEqual({ discrepancyCount: 2, reconciliationDiscrepancyCount: 1, collectionsWithCorrectionsCount: 1, collectionsWithOpenDisputesCount: 1, openDisputeCount: 3 });
    });
  });

  describe('Module 08 adapter — the statement', () => {
    let sql: string;
    let statements: Prisma.Sql[];
    beforeAll(async () => {
      const fake = fakePrisma(row());
      statements = fake.statements;
      await new PrismaCodExceptionSummaryReadAdapter(fake.prisma).summarizeExceptions();
      sql = statements[0].text.replace(/\s+/g, ' ');
    });

    it('is ONE statement (one snapshot, generatedAt from the same clock) with no bound user input', () => {
      expect(statements).toHaveLength(1);
      expect(statements[0].values).toEqual([]);
      expect(sql).toContain('now() AS "generatedAt"');
    });

    it('reuses the exact isOutstanding / hasDiscrepancy predicates Module 08’s summarize uses', () => {
      expect(sql).toContain(`FILTER (WHERE ${COD_OUTSTANDING_SQL.text.replace(/\s+/g, ' ')})::bigint AS "outstandingCount"`);
      expect(sql).toContain(`FILTER (WHERE ${COD_DISCREPANCY_SQL.text.replace(/\s+/g, ' ')})::bigint AS "discrepancyCount"`);
      expect(COD_OUTSTANDING_SQL.text).toBe(`c."status" <> 'RECONCILED'::"CodCollectionStatus"`);
    });

    it('joins only the per-collection-unique legs; corrections and disputes via EXISTS so a collection counts once; open disputes counted as rows separately', () => {
      expect(sql).toContain('FROM "cod_collections" c LEFT JOIN "cod_remittances" r ON r."collectionId" = c."id" LEFT JOIN "cod_reconciliations" rc ON rc."collectionId" = c."id"');
      expect(sql).not.toMatch(/JOIN "cod_corrections"|JOIN "cod_disputes"/);
      expect(sql).toContain('EXISTS (SELECT 1 FROM "cod_corrections" x WHERE x."collectionId" = c."id")');
      expect(sql).toContain(`EXISTS (SELECT 1 FROM "cod_disputes" d WHERE d."collectionId" = c."id" AND d."status" = 'OPEN'::"CodDisputeStatus")`);
      expect(sql).toContain(`(SELECT COUNT(*) FROM "cod_disputes" d WHERE d."status" = 'OPEN'::"CodDisputeStatus")::bigint AS "openDisputeCount"`);
      expect(sql).toContain(`rc."outcome" = 'DISCREPANCY'::"CodReconciliationOutcome"`);
    });

    it('age is floored seconds to the same now(), never negative, and NULL (not 0) when nothing is outstanding', () => {
      expect(sql).toMatch(/CASE WHEN MIN\(c\."collectedAt"\) FILTER \(WHERE .*\) IS NULL THEN NULL ELSE GREATEST\(0, FLOOR\(EXTRACT\(EPOCH FROM \(now\(\) - MIN\(c\."collectedAt"\)/);
    });

    it('selects no amount: no SUM and no money column in the output', () => {
      expect(sql).not.toMatch(/SUM\(/);
      expect(sql).not.toMatch(/AS "(expected|collected|remitted)\w*"/i);
    });
  });

  it('the shared hasDiscrepancy predicate agrees with toCodReconciliationView on the cases it distinguishes', () => {
    // The view's rule, case by case; the SQL predicate (asserted textually above) encodes the same two arms.
    const view = (expected: number, collected: number, remitted: number | null) =>
      toCodReconciliationView({
        collection: { id: 'c', jobId: 'j', orderId: 'o', fulfillmentId: 'f', driverId: 'd', expectedAmount: expected, collectedAmount: collected, currency: 'ETB', method: 'CASH', status: 'COLLECTED', providerReference: null, collectedAt: NOW, recordedAt: NOW, remittedAt: null, reconciledAt: null, settlementRef: null },
        remittance: remitted === null ? null : { id: 'r', collectionId: 'c', remittedAmount: remitted, currency: 'ETB', reference: 'x', note: null, confirmedByUserId: 'u', remittedAt: NOW, recordedAt: NOW },
        reconciliation: null, corrections: [], disputes: [],
      } as CodCollectionRecord).hasDiscrepancy;
    expect([view(100, 100, null), view(100, 90, null), view(100, 100, 100), view(100, 100, 80)]).toEqual([false, true, false, true]);
    expect(COD_DISCREPANCY_SQL.text.replace(/\s+/g, ' ')).toBe(`(c."collectedAmount" <> c."expectedAmount" OR (r."id" IS NOT NULL AND r."remittedAmount" <> c."collectedAmount"))`);
  });

  describe('Module 16 surface', () => {
    it('the query delegates to the port; the response is an explicit allow-list of counts and timestamps', async () => {
      const summary: CodExceptionSummary = {
        generatedAt: NOW,
        collections: { total: 1, byStatus: { COLLECTED: 1, REMITTED: 0, RECONCILED: 0 }, outstandingCount: 1, oldestOutstandingCollectedAt: new Date('2026-10-13T11:00:00Z'), oldestOutstandingAgeSeconds: 3600 },
        exceptions: { discrepancyCount: 0, reconciliationDiscrepancyCount: 0, collectionsWithCorrectionsCount: 0, collectionsWithOpenDisputesCount: 0, openDisputeCount: 0 },
      };
      Object.assign(summary.collections, { oldestCollectionId: 'col-secret', driverId: 'drv-secret' });
      Object.assign(summary, { expectedAmountTotal: 999, note: 'secret' });
      const port: ICodExceptionSummaryReadPort = { summarizeExceptions: async () => summary };
      const res = toCodExceptionSummaryResponse(await new GetCodExceptionSummaryQuery(port).execute());
      expect(res).toEqual({
        generatedAt: '2026-10-13T12:00:00.000Z',
        collections: { total: 1, byStatus: { COLLECTED: 1, REMITTED: 0, RECONCILED: 0 }, outstandingCount: 1, oldestOutstandingCollectedAt: '2026-10-13T11:00:00.000Z', oldestOutstandingAgeSeconds: 3600 },
        exceptions: { discrepancyCount: 0, reconciliationDiscrepancyCount: 0, collectionsWithCorrectionsCount: 0, collectionsWithOpenDisputesCount: 0, openDisputeCount: 0 },
      });
      expect(JSON.stringify(res)).not.toMatch(/secret|999|Id"/);
    });

    it('GET-only under admin/operations/cod/summary with finance:report:any, and registered before Work 38’s :collectionId controller', () => {
      expect(Reflect.getMetadata('path', AdminCodSummaryController)).toBe('admin/operations/cod/summary');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminCodSummaryController)).toEqual(['finance:report:any']);
      expect(Object.getOwnPropertyNames(AdminCodSummaryController.prototype).filter((m) => m !== 'constructor')).toEqual(['get']);
      expect(Reflect.getMetadata('method', AdminCodSummaryController.prototype.get)).toBe(0);
      const controllers = Reflect.getMetadata('controllers', AdminModule) as unknown[];
      expect(controllers.indexOf(AdminCodSummaryController)).toBeGreaterThanOrEqual(0);
      expect(controllers.indexOf(AdminCodSummaryController)).toBeLessThan(controllers.indexOf(AdminCodOperationsController));
    });
  });
});
