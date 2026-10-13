import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../../../prisma/rbac-catalog';
import { ApiException } from '../../../shared/errors/api-exception';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { hasPermission } from '../../../shared/rbac/permission-matcher';
import { PERMISSIONS_KEY } from '../../../shared/rbac/permissions.decorator';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodOperationsDetail,
  CodOperationsFilter,
  CodOperationsSummary,
  CodReconciliationOutcome,
  ICodOperationsReadPort,
} from '../../delivery/application/ports/inbound/cod-operations-read.port';
import { ListCodCollectionsQuery } from '../../delivery/application/queries/list-cod-collections.query';
import { CodCollectionRecord, ICodCollectionRepository } from '../../delivery/domain/repositories/cod-collection.repository';
import { PrismaCodOperationsReadAdapter } from '../../delivery/infrastructure/persistence/prisma-cod-operations-read.adapter';
import { AdminCodOperationsController } from '../interface/controllers/admin-cod-operations.controller';
import { ListCodOperationsQueryDto } from '../interface/dtos/cod-operations.dto';
import { toCodOperationsDetailResponse, toCodOperationsListResponse } from '../interface/dtos/cod-operations.response';
import { GetCodOperationsQuery, ListCodOperationsQuery, MAX_COD_OPERATIONS_PAGE_SIZE } from './queries/cod-operations.queries';

const C1 = '11111111-1111-4111-8111-111111111111';
const O1 = '22222222-2222-4222-8222-222222222222';
const J1 = '33333333-3333-4333-8333-333333333333';
const at = (h: number) => new Date(`2026-10-01T${String(h).padStart(2, '0')}:00:00Z`);
const SUMMARY_KEYS = [
  'collectionId', 'jobId', 'orderId', 'fulfillmentId', 'driverProfileId', 'status', 'method', 'currency', 'expectedAmount', 'collectedAmount',
  'remittedAmount', 'collectionVariance', 'remittanceVariance', 'hasDiscrepancy', 'isOutstanding', 'reconciliationOutcome',
  'collectedAt', 'recordedAt', 'remittedAt', 'reconciledAt', 'correctionCount', 'disputeCount', 'openDisputeCount',
];

/** A stored Module 08 record, with every sensitive free-text and actor column filled in. */
function record(over: Partial<CodCollectionRecord> = {}): CodCollectionRecord {
  return {
    collection: {
      id: C1, jobId: J1, orderId: O1, fulfillmentId: 'f-1', driverId: 'drv-1', expectedAmount: 12_500, collectedAmount: 12_000, currency: 'ETB',
      method: CodCollectionMethod.ELECTRONIC, status: CodCollectionStatus.COLLECTED, providerReference: 'TELEBIRR-SECRET-TXN',
      collectedAt: at(9), recordedAt: at(10), remittedAt: null, reconciledAt: null, settlementRef: 'SETTLE-SECRET',
    },
    remittance: null,
    reconciliation: null,
    corrections: [],
    disputes: [],
    ...over,
  };
}
const remitted = (): Partial<CodCollectionRecord> => ({
  remittance: { id: 'rem-1', collectionId: C1, remittedAmount: 11_500, currency: 'ETB', reference: 'SLIP-SECRET-77', note: 'counted at desk by Abebe', confirmedByUserId: 'user-finance-secret', remittedAt: at(12), recordedAt: at(13) },
});

describe('Admin COD operations (application)', () => {
  let filters: Array<{ f: CodOperationsFilter; page: number; size: number }>;
  let detail: CodOperationsDetail | null;
  let list: ListCodOperationsQuery;
  let get: GetCodOperationsQuery;

  const summary = (over: Partial<CodOperationsSummary> = {}): CodOperationsSummary => ({
    collectionId: C1, jobId: J1, orderId: O1, fulfillmentId: 'f-1', driverProfileId: 'drv-1', status: CodCollectionStatus.COLLECTED,
    method: CodCollectionMethod.CASH, currency: 'ETB', expectedAmount: 100, collectedAmount: 100, remittedAmount: null, collectionVariance: 0,
    remittanceVariance: null, hasDiscrepancy: false, isOutstanding: true, reconciliationOutcome: null, collectedAt: at(9), recordedAt: at(9),
    remittedAt: null, reconciledAt: null, correctionCount: 0, disputeCount: 0, openDisputeCount: 0, ...over,
  });

  beforeEach(() => {
    filters = [];
    detail = { ...summary(), remittance: null, reconciliation: null, corrections: [], disputes: [] };
    const port: ICodOperationsReadPort = {
      listCollections: async (f, page, size) => (filters.push({ f, page, size }), { items: [summary()], total: 1, page, size }),
      getCollection: async () => detail,
    };
    list = new ListCodOperationsQuery(port);
    get = new GetCodOperationsQuery(port);
  });

  const outcome = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof ApiException ? `${e.httpStatus} ${e.code}` : String(e);
    }
  };
  const dtoErrors = (plain: object) =>
    validateSync(plainToInstance(ListCodOperationsQueryDto, plain), { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);

  /** The real Module 08 adapter over a repository double, so Module 08's own projection runs. */
  function adapterOver(records: CodCollectionRecord[]) {
    const searches: unknown[] = [];
    let isolation: unknown;
    const repo = {
      search: async (c: { page: number; size: number }) => (searches.push(c), { items: records, total: records.length, page: c.page, size: c.size }),
      findRecordById: async (id: string, tx: unknown) => (expect(tx).toBe('TX'), records.find((r) => r.collection.id === id) ?? null),
    } as unknown as ICodCollectionRepository;
    const prisma = { $transaction: async (fn: (tx: unknown) => unknown, o: unknown) => ((isolation = o), fn('TX')) } as unknown as PrismaService;
    return { adapter: new PrismaCodOperationsReadAdapter(prisma, repo, new ListCodCollectionsQuery(repo)), searches, isolation: () => isolation };
  }

  describe('list', () => {
    it('an empty list is a valid page', async () => {
      const empty: ICodOperationsReadPort = { listCollections: async (_f, page, size) => ({ items: [], total: 0, page, size }), getCollection: async () => null };
      expect(toCodOperationsListResponse(await new ListCodOperationsQuery(empty).execute({}))).toEqual({ items: [], total: 0, page: 1, size: 20 });
    });

    it('pages default to 1/20 and clamp to 100; filters are forwarded exactly; the adapter passes them to Module 08’s finance search', async () => {
      await list.execute({});
      await list.execute({ page: 4, size: 1000, status: CodCollectionStatus.REMITTED, orderId: O1, jobId: J1, collectedFrom: at(1), collectedTo: at(2) });
      await list.execute({ page: 0, size: -1 });
      expect(filters.map(({ page, size }) => [page, size])).toEqual([[1, 20], [4, MAX_COD_OPERATIONS_PAGE_SIZE], [1, 20]]);
      expect(filters[1].f).toEqual({ status: 'REMITTED', orderId: O1, jobId: J1, collectedFrom: at(1), collectedTo: at(2) });
      const { adapter, searches } = adapterOver([]);
      await adapter.listCollections(filters[1].f, 4, 100);
      expect(searches).toEqual([{ status: 'REMITTED', orderId: O1, jobId: J1, from: at(1), to: at(2), page: 4, size: 100 }]);
    });

    it('a summary carries exactly the approved fields', async () => {
      expect(Object.keys(toCodOperationsListResponse(await list.execute({})).items[0])).toEqual(SUMMARY_KEYS);
    });

    it('request validation: Module 08 CodCollectionStatus values only; UUID ids; ISO dates; bounded page/size; unknown parameters refused', () => {
      expect(Object.values(CodCollectionStatus)).toEqual(['COLLECTED', 'REMITTED', 'RECONCILED']);
      for (const status of Object.values(CodCollectionStatus)) expect(dtoErrors({ status })).toEqual([]);
      for (const status of ['SETTLED', 'DISCREPANCY', 'PAID']) expect(dtoErrors({ status })).toEqual(['status']);
      expect(dtoErrors({ orderId: O1, jobId: J1, collectedFrom: '2026-10-01', collectedTo: '2026-10-02T00:00:00Z' })).toEqual([]);
      expect(dtoErrors({ orderId: 'ORD-1' })).toEqual(['orderId']);
      expect(dtoErrors({ jobId: '42' })).toEqual(['jobId']);
      expect(dtoErrors({ collectedFrom: 'last week' })).toEqual(['collectedFrom']);
      expect(dtoErrors({ page: 0 })).toEqual(['page']);
      expect(dtoErrors({ size: 101 })).toEqual(['size']);
      for (const field of ['driverId', 'remittanceReference', 'currency', 'q', 'from']) expect(dtoErrors({ [field]: 'x' })).toEqual([field]);
    });
  });

  describe('detail through Module 08’s projection', () => {
    it('a collection with no remittance or reconciliation: nulls, not zeros; outstanding; no invented outcome', async () => {
      const { adapter, isolation } = adapterOver([record()]);
      const d = toCodOperationsDetailResponse((await adapter.getCollection(C1))!);
      expect(isolation()).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(d).toMatchObject({
        status: 'COLLECTED', expectedAmount: 12_500, collectedAmount: 12_000, remittedAmount: null, collectionVariance: -500, remittanceVariance: null,
        hasDiscrepancy: true, isOutstanding: true, reconciliationOutcome: null, remittance: null, reconciliation: null, corrections: [], disputes: [],
      });
      expect(Object.keys(d)).toEqual([...SUMMARY_KEYS, 'remittance', 'reconciliation', 'corrections', 'disputes']);
    });

    it('a remittance alone does not make a collection reconciled; stages stay distinct', async () => {
      const { adapter } = adapterOver([record({ ...remitted(), collection: { ...record().collection, status: CodCollectionStatus.REMITTED, remittedAt: at(12) } })]);
      const d = (await adapter.getCollection(C1))!;
      expect([d.status, d.isOutstanding, d.reconciliationOutcome, d.reconciliation]).toEqual(['REMITTED', true, null, null]);
      expect([d.expectedAmount, d.collectedAmount, d.remittedAmount, d.collectionVariance, d.remittanceVariance]).toEqual([12_500, 12_000, 11_500, -500, -500]);
      expect(d.remittance).toEqual({ remittanceId: 'rem-1', remittedAmount: 11_500, currency: 'ETB', remittedAt: at(12), recordedAt: at(13) });
    });

    it('a recorded DISCREPANCY and several corrections: the finding as recorded, corrections listed beside it, variances still from the original rows', async () => {
      const base = record().collection;
      const { adapter } = adapterOver([
        record({
          ...remitted(),
          collection: { ...base, status: CodCollectionStatus.RECONCILED, remittedAt: at(12), reconciledAt: at(14) },
          reconciliation: { id: 'rec-1', collectionId: C1, outcome: CodReconciliationOutcome.DISCREPANCY, reference: 'RUN-SECRET', note: 'driver short, see Almaz', reconciledByUserId: 'user-recon-secret', reconciledAt: at(14) },
          corrections: [
            { id: 'cor-1', collectionId: C1, remittanceId: null, reconciliationId: null, type: CodCorrectionType.RECORDING_MISTAKE, originalAmount: 12_000, correctedAmount: 11_500, originalReference: null, correctedReference: null, reason: 'driver typo per phone call +251911', idempotencyKey: 'idem-secret-1', createdByUserId: 'user-cor-secret', createdAt: at(15) },
            { id: 'cor-2', collectionId: C1, remittanceId: 'rem-1', reconciliationId: null, type: CodCorrectionType.REFERENCE_CORRECTION, originalAmount: null, correctedAmount: null, originalReference: 'SLIP-OLD-SECRET', correctedReference: 'SLIP-NEW-SECRET', reason: 'slip mistyped', idempotencyKey: 'idem-secret-2', createdByUserId: 'user-cor-secret', createdAt: at(16) },
          ],
          disputes: [
            { id: 'dis-2', collectionId: C1, reason: 'customer claims paid in full', status: CodDisputeStatus.OPEN, openedByUserId: 'user-d-secret', openedAt: at(17), resolvedByUserId: null, resolvedAt: null, resolutionNote: null },
            { id: 'dis-1', collectionId: C1, reason: 'short', status: CodDisputeStatus.RESOLVED, openedAt: at(15), openedByUserId: 'user-d-secret', resolvedByUserId: 'user-r-secret', resolvedAt: at(16), resolutionNote: 'paid back by driver Abebe' },
          ],
        }),
      ]);
      const d = toCodOperationsDetailResponse((await adapter.getCollection(C1))!);
      expect([d.status, d.isOutstanding, d.reconciliationOutcome, d.hasDiscrepancy]).toEqual(['RECONCILED', false, 'DISCREPANCY', true]);
      expect([d.collectedAmount, d.collectionVariance, d.remittanceVariance]).toEqual([12_000, -500, -500]); // not restated by cor-1
      expect(d.corrections).toEqual([
        { correctionId: 'cor-1', type: 'RECORDING_MISTAKE', remittanceId: null, reconciliationId: null, originalAmount: 12_000, correctedAmount: 11_500, createdAt: at(15).toISOString() },
        { correctionId: 'cor-2', type: 'REFERENCE_CORRECTION', remittanceId: 'rem-1', reconciliationId: null, originalAmount: null, correctedAmount: null, createdAt: at(16).toISOString() },
      ]);
      expect(d.disputes).toEqual([
        { disputeId: 'dis-2', status: 'OPEN', openedAt: at(17).toISOString(), resolvedAt: null },
        { disputeId: 'dis-1', status: 'RESOLVED', openedAt: at(15).toISOString(), resolvedAt: at(16).toISOString() },
      ]);
      expect([d.correctionCount, d.disputeCount, d.openDisputeCount]).toEqual([2, 2, 1]);
      expect(d.reconciliation).toEqual({ reconciliationId: 'rec-1', outcome: 'DISCREPANCY', reconciledAt: at(14).toISOString() });
      for (const k of ['netAmount', 'adjustedAmount', 'settlementStatus', 'balance', 'amountDelta']) expect(d).not.toHaveProperty(k);
      // Privacy: no free text, references, idempotency keys or Module 01 user ids.
      const raw = JSON.stringify(d);
      expect(raw).not.toMatch(/SECRET|Abebe|Almaz|\+2519|typo|mistyped|claims|short|idem-|user-/);
      expect(raw).not.toMatch(/"(note|reason|reference|providerReference|settlementRef|originalReference|correctedReference|resolutionNote|idempotencyKey)"|ByUserId"/);
    });

    it('unknown collection → adapter null → 404', async () => {
      const { adapter } = adapterOver([]);
      expect(await adapter.getCollection(C1)).toBeNull();
      detail = null;
      expect(await outcome(get.execute(C1))).toBe('404 NOT_FOUND');
    });

    it('explicit allow-list: extra properties on a port object never reach the response', async () => {
      detail = Object.assign({ ...summary(), remittance: null, reconciliation: null, corrections: [], disputes: [] }, { providerReference: 'TXN-SECRET', note: 'secret note', driverPhone: '+251911' });
      expect(JSON.stringify(toCodOperationsDetailResponse(await get.execute(C1)))).not.toMatch(/SECRET|secret|\+2519|providerReference|note/);
    });
  });

  describe('authorization and read-only shape', () => {
    it('both routes are GET under admin/operations/cod and take finance:report:any; no other route; the port only reads', () => {
      expect(Reflect.getMetadata('path', AdminCodOperationsController)).toBe('admin/operations/cod');
      expect(Reflect.getMetadata(PERMISSIONS_KEY, AdminCodOperationsController)).toEqual(['finance:report:any']);
      const methods = Object.getOwnPropertyNames(AdminCodOperationsController.prototype).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['search', 'detail']);
      for (const m of methods) {
        expect({ m, method: Reflect.getMetadata('method', AdminCodOperationsController.prototype[m as 'search']) }).toEqual({ m, method: 0 });
      }
      expect(Object.getOwnPropertyNames(PrismaCodOperationsReadAdapter.prototype).filter((m) => m !== 'constructor')).toEqual(['listCollections', 'getCollection']);
    });

    it('finance:report:any is the existing read-only finance grant: ADMIN and FINANCE_OFFICER (SUPER_ADMIN by wildcard); it implies no settlement, delivery or driver action', () => {
      expect(PERMISSIONS.find((p) => p.key === 'finance:report:any')).toEqual({ key: 'finance:report:any', resource: 'finance', action: 'report', scope: 'any' });
      for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
        expect({ role, ok: hasPermission(grants, 'finance:report:any') }).toEqual({ role, ok: ['ADMIN', 'FINANCE_OFFICER', 'SUPER_ADMIN'].includes(role) });
      }
      for (const action of ['finance:settlement:any', 'delivery:update:own', 'delivery:update:any', 'driver:read:any']) {
        expect({ action, ok: hasPermission(['finance:report:any'], action) }).toEqual({ action, ok: false });
      }
      expect(hasPermission(['delivery:read:any', 'driver:read:any', 'analytics:read'], 'finance:report:any')).toBe(false);
    });
  });
});
