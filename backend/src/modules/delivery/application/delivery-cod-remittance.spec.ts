import { AuditService } from '../../../shared/audit/audit.service';
import { DomainEvent } from '../../../shared/events/domain-event';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { CodCollectionProps } from '../domain/entities/cod-collection.entity';
import {
  CodReconciliation,
  CodReconciliationProps,
} from '../domain/entities/cod-reconciliation.entity';
import { CodCorrectionProps } from '../domain/entities/cod-correction.entity';
import { CodDisputeProps } from '../domain/entities/cod-dispute.entity';
import { CodRemittance, CodRemittanceProps } from '../domain/entities/cod-remittance.entity';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  CodReconciliationOutcome,
} from '../domain/enums';
import { CodReconciledPayload, CodRemittedPayload, DeliveryEventType } from '../domain/events';
import {
  CodCollectionPage,
  CodCollectionRecord,
  CodCollectionSearchCriteria,
  CodDisputePage,
  ICodCollectionRepository,
} from '../domain/repositories/cod-collection.repository';
import {
  CodCollectionPolicy,
  CodRemittanceOutcome,
} from '../domain/services/cod-collection-policy';
import { ReconcileCodCollectionCommand } from './commands/reconcile-cod-collection.command';
import { RecordCodRemittanceCommand } from './commands/record-cod-remittance.command';
import { ListCodCollectionsQuery } from './queries/list-cod-collections.query';
import { IUnitOfWork } from './ports/unit-of-work.port';

const COLLECTION = 'cod-collection-1';
const EXPECTED = 24_500;
const FINANCE_USER = 'user-finance-1';
const OTHER_FINANCE_USER = 'user-finance-2';

/**
 * An in-memory COD store that **enforces the real constraints** rather than merely holding rows.
 *
 * Both unique indexes are honoured, and both status advances are genuine compare-and-sets that
 * return `false` from the wrong state. That is what lets a concurrency or lifecycle defect fail
 * here as well as against PostgreSQL — a fake that simply assigned `status = REMITTED` would pass
 * every test in this file and prove nothing about either.
 */
class FakeCodCollectionRepository implements ICodCollectionRepository {
  readonly collections = new Map<string, CodCollectionProps>();
  readonly remittances = new Map<string, CodRemittanceProps>();
  readonly reconciliations = new Map<string, CodReconciliationProps>();

  /** Runs once immediately before the next remittance insert, to open a race window. */
  onInsertRemittance: (() => Promise<void>) | null = null;
  /** The same, for reconciliation. */
  onInsertReconciliation: (() => Promise<void>) | null = null;

  seed(overrides: Partial<CodCollectionProps> = {}): CodCollectionProps {
    const collection: CodCollectionProps = {
      id: COLLECTION,
      jobId: 'job-1',
      orderId: 'order-1',
      fulfillmentId: 'fulfillment-1',
      driverId: 'driver-profile-1',
      expectedAmount: EXPECTED,
      collectedAmount: EXPECTED,
      currency: 'ETB',
      method: CodCollectionMethod.CASH,
      status: CodCollectionStatus.COLLECTED,
      providerReference: null,
      collectedAt: new Date('2026-09-20T10:00:00.000Z'),
      recordedAt: new Date('2026-09-20T10:01:00.000Z'),
      remittedAt: null,
      reconciledAt: null,
      settlementRef: null,
      ...overrides,
    };
    this.collections.set(collection.id, collection);
    return collection;
  }

  async insert(collection: CodCollectionProps): Promise<CodCollectionProps | null> {
    if ([...this.collections.values()].some((row) => row.jobId === collection.jobId)) {
      return null;
    }
    this.collections.set(collection.id, collection);
    return collection;
  }

  async findByJobId(jobId: string): Promise<CodCollectionProps | null> {
    return [...this.collections.values()].find((row) => row.jobId === jobId) ?? null;
  }

  async findById(collectionId: string): Promise<CodCollectionProps | null> {
    return this.collections.get(collectionId) ?? null;
  }

  async advanceToRemitted(collectionId: string, remittedAt: Date): Promise<boolean> {
    const row = this.collections.get(collectionId);
    if (!row || row.status !== CodCollectionStatus.COLLECTED) {
      return false;
    }
    this.collections.set(collectionId, {
      ...row,
      status: CodCollectionStatus.REMITTED,
      remittedAt,
    });
    return true;
  }

  async advanceToReconciled(collectionId: string, reconciledAt: Date): Promise<boolean> {
    const row = this.collections.get(collectionId);
    if (!row || row.status !== CodCollectionStatus.REMITTED) {
      return false;
    }
    this.collections.set(collectionId, {
      ...row,
      status: CodCollectionStatus.RECONCILED,
      reconciledAt,
    });
    return true;
  }

  async insertRemittance(remittance: CodRemittanceProps): Promise<CodRemittanceProps | null> {
    if (this.onInsertRemittance) {
      const hook = this.onInsertRemittance;
      this.onInsertRemittance = null;
      await hook();
    }
    if (this.remittances.has(remittance.collectionId)) {
      return null;
    }
    this.remittances.set(remittance.collectionId, remittance);
    return remittance;
  }

  async findRemittanceByCollectionId(collectionId: string): Promise<CodRemittanceProps | null> {
    return this.remittances.get(collectionId) ?? null;
  }

  async insertReconciliation(
    reconciliation: CodReconciliationProps,
  ): Promise<CodReconciliationProps | null> {
    if (this.onInsertReconciliation) {
      const hook = this.onInsertReconciliation;
      this.onInsertReconciliation = null;
      await hook();
    }
    if (this.reconciliations.has(reconciliation.collectionId)) {
      return null;
    }
    this.reconciliations.set(reconciliation.collectionId, reconciliation);
    return reconciliation;
  }

  async findReconciliationByCollectionId(
    collectionId: string,
  ): Promise<CodReconciliationProps | null> {
    return this.reconciliations.get(collectionId) ?? null;
  }

  async findRecordById(collectionId: string): Promise<CodCollectionRecord | null> {
    const collection = this.collections.get(collectionId);
    if (!collection) {
      return null;
    }
    return {
      collection,
      remittance: this.remittances.get(collectionId) ?? null,
      reconciliation: this.reconciliations.get(collectionId) ?? null,
      // Empty here: this suite is about the three-step lifecycle, and a correction changes none of
      // it. The corrections suite drives these two lists.
      corrections: [],
      disputes: [],
    };
  }


  // ------------------------------------------------------------------------------------------
  // Corrections and disputes.
  //
  // Unused in this suite and deliberately fatal rather than silently empty, for the reason the
  // remittance stubs above give: a stub that quietly returned an empty list would let a future
  // change start depending on correction behaviour here without anybody noticing. The corrections
  // suite has a fake that actually implements them.
  // ------------------------------------------------------------------------------------------

  async insertCorrection(): Promise<CodCorrectionProps | null> {
    throw new Error('not used in this suite');
  }

  async findCorrectionByIdempotencyKey(): Promise<CodCorrectionProps | null> {
    throw new Error('not used in this suite');
  }

  async listCorrections(): Promise<CodCorrectionProps[]> {
    throw new Error('not used in this suite');
  }

  async insertDispute(): Promise<CodDisputeProps | null> {
    throw new Error('not used in this suite');
  }

  async findDisputeById(): Promise<CodDisputeProps | null> {
    throw new Error('not used in this suite');
  }

  async findOpenDispute(): Promise<CodDisputeProps | null> {
    throw new Error('not used in this suite');
  }

  async listDisputes(): Promise<CodDisputeProps[]> {
    throw new Error('not used in this suite');
  }

  async searchDisputes(): Promise<CodDisputePage> {
    throw new Error('not used in this suite');
  }

  async resolveDispute(): Promise<boolean> {
    throw new Error('not used in this suite');
  }

  async search(criteria: CodCollectionSearchCriteria): Promise<CodCollectionPage> {
    let rows = [...this.collections.values()];
    if (criteria.driverId) {
      rows = rows.filter((row) => row.driverId === criteria.driverId);
    }
    if (criteria.status) {
      rows = rows.filter((row) => row.status === criteria.status);
    }
    if (criteria.currency) {
      rows = rows.filter((row) => row.currency === criteria.currency);
    }
    if (criteria.orderId) {
      rows = rows.filter((row) => row.orderId === criteria.orderId);
    }
    if (criteria.remittanceReference) {
      rows = rows.filter(
        (row) => this.remittances.get(row.id)?.reference === criteria.remittanceReference,
      );
    }
    if (criteria.from) {
      rows = rows.filter((row) => row.collectedAt >= criteria.from!);
    }
    if (criteria.to) {
      rows = rows.filter((row) => row.collectedAt <= criteria.to!);
    }
    rows.sort((a, b) => b.collectedAt.getTime() - a.collectedAt.getTime());
    const start = (criteria.page - 1) * criteria.size;
    return {
      items: rows.slice(start, start + criteria.size).map((collection) => ({
        collection,
        remittance: this.remittances.get(collection.id) ?? null,
        reconciliation: this.reconciliations.get(collection.id) ?? null,
        corrections: [],
        disputes: [],
      })),
      total: rows.length,
      page: criteria.page,
      size: criteria.size,
    };
  }

  // Work 14's finance aggregate. Exercised against real SQL in
  // `test/delivery/cod-reporting.e2e-spec.ts`; the totals are computed by Postgres, so a hand-rolled
  // fake here would only test the fake.
  summarize(): Promise<never> {
    throw new Error('summarize is not used in these unit tests.');
  }
}

/** Runs the closure immediately; no isolation to simulate, because the fakes are synchronous. */
const fakeUow: IUnitOfWork = { run: async (work) => work({}) };

describe('COD remittance and reconciliation', () => {
  let repo: FakeCodCollectionRepository;
  let entries: { action: string; actorUserId?: string | null; context: Record<string, unknown> }[];
  let events: DomainEvent<Record<string, unknown>>[];
  let remit: RecordCodRemittanceCommand;
  let reconcile: ReconcileCodCollectionCommand;
  let list: ListCodCollectionsQuery;

  beforeEach(() => {
    repo = new FakeCodCollectionRepository();
    entries = [];
    events = [];

    const audit = {
      record: async (params: {
        action: string;
        actorUserId?: string | null;
        context?: Record<string, unknown> | null;
      }) => {
        entries.push({
          action: params.action,
          actorUserId: params.actorUserId,
          context: params.context ?? {},
        });
        return { id: 'audit-1', hash: 'hash-1' };
      },
    } as unknown as AuditService;

    const outbox = {
      write: async (event: DomainEvent<Record<string, unknown>>) => {
        events.push(event);
      },
    } as unknown as OutboxService;

    remit = new RecordCodRemittanceCommand(repo, fakeUow, audit, outbox);
    reconcile = new ReconcileCodCollectionCommand(repo, fakeUow, audit, outbox);
    list = new ListCodCollectionsQuery(repo);
  });

  function remitInput(overrides: Record<string, unknown> = {}) {
    return {
      actorUserId: FINANCE_USER,
      collectionId: COLLECTION,
      remittedAmount: EXPECTED,
      reference: 'CASHDESK-2026-09-20-A',
      ...overrides,
    } as Parameters<RecordCodRemittanceCommand['execute']>[0];
  }

  async function remitted(collected = EXPECTED, remittedAmount = EXPECTED) {
    repo.seed({ collectedAmount: collected });
    await remit.execute(remitInput({ remittedAmount }));
  }

  // ===========================================================================================
  // The lifecycle boundary — §5's `COLLECTED → REMITTED → RECONCILED`
  // ===========================================================================================

  describe('lifecycle', () => {
    it('records a remittance against a collected collection and advances it to REMITTED', async () => {
      repo.seed();

      const result = await remit.execute(remitInput());

      expect(result.created).toBe(true);
      expect(result.collection.status).toBe(CodCollectionStatus.REMITTED);
      expect(result.remittance.remittedAmount).toBe(EXPECTED);
      expect(result.remittance.confirmedByUserId).toBe(FINANCE_USER);
      expect(repo.collections.get(COLLECTION)?.remittedAt).toBeInstanceOf(Date);
    });

    it('refuses to reconcile a collection that has only been collected', async () => {
      repo.seed();

      // The whole reason the three-step lifecycle exists: PharmaLink must not certify money it has
      // not been handed, on the word of the channel still holding it.
      await expect(
        reconcile.execute({ actorUserId: FINANCE_USER, collectionId: COLLECTION }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(repo.reconciliations.size).toBe(0);
      expect(repo.collections.get(COLLECTION)?.status).toBe(CodCollectionStatus.COLLECTED);
    });

    it('reconciles a remitted collection', async () => {
      await remitted();

      const result = await reconcile.execute({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
      });

      expect(result.created).toBe(true);
      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.ACCEPTED);
      expect(result.reconciliation.reconciledByUserId).toBe(OTHER_FINANCE_USER);
      expect(repo.collections.get(COLLECTION)?.status).toBe(CodCollectionStatus.RECONCILED);
      expect(repo.collections.get(COLLECTION)?.reconciledAt).toBeInstanceOf(Date);
    });

    it('refuses a second, different remittance once a collection has been remitted', async () => {
      await remitted();

      await expect(
        remit.execute(remitInput({ remittedAmount: 1, reference: 'OTHER' })),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(repo.remittances.size).toBe(1);
      expect(repo.remittances.get(COLLECTION)?.remittedAmount).toBe(EXPECTED);
    });

    it('refuses a remittance against a collection that does not exist', async () => {
      await expect(remit.execute(remitInput({ collectionId: 'missing' }))).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('refuses a reconciliation against a collection that does not exist', async () => {
      await expect(
        reconcile.execute({ actorUserId: FINANCE_USER, collectionId: 'missing' }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('refuses a remittance against an already reconciled collection', async () => {
      await remitted();
      await reconcile.execute({ actorUserId: FINANCE_USER, collectionId: COLLECTION });

      // Distinct from a replay: the stored remittance differs, so this is a restatement attempt.
      await expect(
        remit.execute(remitInput({ remittedAmount: 999, reference: 'LATE' })),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });
  });

  // ===========================================================================================
  // Amounts — §4's exact / short / over, and §6's discrepancy rules
  // ===========================================================================================

  describe('amounts', () => {
    it('records an exact remittance', async () => {
      repo.seed();
      const result = await remit.execute(remitInput());

      expect(result.outcome).toBe(CodRemittanceOutcome.Exact);
      expect(result.variance).toBe(0);
    });

    it('records a short remittance rather than refusing it', async () => {
      repo.seed();

      const result = await remit.execute(remitInput({ remittedAmount: 20_000 }));

      // Recorded, not rejected: refusing would leave no trace that the channel came up short, and
      // would push an operator towards keying in the expected figure instead of the true one.
      expect(result.created).toBe(true);
      expect(result.outcome).toBe(CodRemittanceOutcome.Short);
      expect(result.variance).toBe(-4_500);
      expect(repo.remittances.get(COLLECTION)?.remittedAmount).toBe(20_000);
    });

    it('records an over-remittance', async () => {
      repo.seed();

      const result = await remit.execute(remitInput({ remittedAmount: 25_000 }));

      expect(result.outcome).toBe(CodRemittanceOutcome.Over);
      expect(result.variance).toBe(500);
    });

    it('never overwrites the collected amount when the remitted amount differs', async () => {
      repo.seed();
      await remit.execute(remitInput({ remittedAmount: 20_000 }));

      // §3: preserve both facts. The driver's declaration is evidence and is untouched.
      expect(repo.collections.get(COLLECTION)?.collectedAmount).toBe(EXPECTED);
      expect(repo.collections.get(COLLECTION)?.expectedAmount).toBe(EXPECTED);
    });

    it('does not mark a collection reconciled merely because a remittance was recorded', async () => {
      repo.seed();
      await remit.execute(remitInput());

      // §4, stated as an assertion rather than a comment.
      expect(repo.collections.get(COLLECTION)?.status).toBe(CodCollectionStatus.REMITTED);
      expect(repo.collections.get(COLLECTION)?.reconciledAt).toBeNull();
      expect(repo.reconciliations.size).toBe(0);
    });

    it('records a DISCREPANCY when less arrived than the driver declared', async () => {
      await remitted(EXPECTED, 20_000);

      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        note: 'Short by 4,500 — cash desk counted twice.',
      });

      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);
      expect(result.remittanceVariance).toBe(-4_500);
      // Still reconciled: `RECONCILED` means somebody looked, and `outcome` says what they found.
      expect(repo.collections.get(COLLECTION)?.status).toBe(CodCollectionStatus.RECONCILED);
    });

    it('records a DISCREPANCY when the collection itself was short, even on a faithful remittance', async () => {
      // The case worth naming: a driver who collected 20,000 against a 24,500 order and then
      // honestly handed over all 20,000 has a clean remittance and a platform still 4,500 short.
      await remitted(20_000, 20_000);

      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);
      expect(result.collectionVariance).toBe(-4_500);
      expect(result.remittanceVariance).toBe(0);
    });

    it('refuses a remittance in a currency the collection was not taken in', async () => {
      repo.seed();

      await expect(remit.execute(remitInput({ currency: 'USD' }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      expect(repo.remittances.size).toBe(0);
    });

    it('accepts a zero remittance — a channel that turned up with nothing is a fact', async () => {
      repo.seed();

      const result = await remit.execute(remitInput({ remittedAmount: 0 }));

      expect(result.created).toBe(true);
      expect(result.outcome).toBe(CodRemittanceOutcome.Short);
    });

    it('refuses a negative remitted amount', async () => {
      repo.seed();

      await expect(remit.execute(remitInput({ remittedAmount: -1 }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('refuses a remittance with no reference', async () => {
      repo.seed();

      await expect(remit.execute(remitInput({ reference: '   ' }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });
  });

  // ===========================================================================================
  // The outcome is computed, never supplied
  // ===========================================================================================

  describe('outcome derivation', () => {
    it('has no input through which an operator could claim ACCEPTED on a shortfall', async () => {
      await remitted(EXPECTED, 1);

      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        // `note` and `reference` are the only two things a caller may supply. There is no
        // `outcome` field on the input type at all — this is the guarantee, in one assertion.
        note: 'Everything is fine, honestly.',
        reference: 'RUN-1',
      });

      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);
    });

    it('treats a currency mismatch between the two rows as a discrepancy, never a conversion', async () => {
      const collection = repo.seed();
      const remittance = CodRemittance.record({
        id: 'rem-1',
        collectionId: collection.id,
        remittedAmount: EXPECTED,
        currency: 'USD',
        reference: 'X',
        confirmedByUserId: FINANCE_USER,
      }).toProps();

      expect(CodCollectionPolicy.classifyReconciliation(collection, remittance)).toBe(
        CodReconciliationOutcome.DISCREPANCY,
      );
    });

    it('refuses to construct a reconciliation with an outcome outside the enum', () => {
      expect(() =>
        CodReconciliation.record({
          id: 'rec-1',
          collectionId: COLLECTION,
          outcome: 'SETTLED' as CodReconciliationOutcome,
          reconciledByUserId: FINANCE_USER,
        }),
      ).toThrow();
    });
  });

  // ===========================================================================================
  // Idempotency and concurrency — §12, §13
  // ===========================================================================================

  describe('idempotency', () => {
    it('replays an identical remittance without a second row, audit entry or event', async () => {
      repo.seed();
      await remit.execute(remitInput());
      const auditCount = entries.length;
      const eventCount = events.length;

      const replay = await remit.execute(remitInput());

      expect(replay.created).toBe(false);
      expect(repo.remittances.size).toBe(1);
      expect(entries).toHaveLength(auditCount);
      expect(events).toHaveLength(eventCount);
    });

    it('replays an identical reconciliation without a second row, audit entry or event', async () => {
      await remitted();
      await reconcile.execute({ actorUserId: FINANCE_USER, collectionId: COLLECTION });
      const auditCount = entries.length;
      const eventCount = events.length;

      const replay = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      expect(replay.created).toBe(false);
      expect(repo.reconciliations.size).toBe(1);
      expect(entries).toHaveLength(auditCount);
      expect(events).toHaveLength(eventCount);
    });

    it('cannot move a reconciled collection backward', async () => {
      await remitted();
      const first = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      await reconcile.execute({ actorUserId: OTHER_FINANCE_USER, collectionId: COLLECTION });

      expect(repo.collections.get(COLLECTION)?.status).toBe(CodCollectionStatus.RECONCILED);
      // The committed finding still names the operator who actually made it.
      expect(repo.reconciliations.get(COLLECTION)?.reconciledByUserId).toBe(FINANCE_USER);
      expect(repo.reconciliations.get(COLLECTION)?.id).toBe(first.reconciliation.id);
    });

    it('refuses a reconciliation replay that restates the finding', async () => {
      await remitted();
      await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        note: 'Counted and matched.',
      });

      await expect(
        reconcile.execute({
          actorUserId: FINANCE_USER,
          collectionId: COLLECTION,
          note: 'Actually it was short.',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('converges two concurrent remittances on one row', async () => {
      repo.seed();
      // The competing writer commits inside the first one's transaction, exactly where a second
      // API node would. Only the database can settle this, which is why the fake enforces the index.
      repo.onInsertRemittance = async () => {
        await remit.execute(remitInput({ actorUserId: OTHER_FINANCE_USER }));
      };

      const result = await remit.execute(remitInput());

      expect(repo.remittances.size).toBe(1);
      expect(result.created).toBe(false);
      expect(result.remittance.confirmedByUserId).toBe(OTHER_FINANCE_USER);
      expect(events.filter((e) => e.type === DeliveryEventType.CodRemitted)).toHaveLength(1);
    });

    it('converges two concurrent reconciliations on one finding', async () => {
      await remitted();
      repo.onInsertReconciliation = async () => {
        await reconcile.execute({ actorUserId: OTHER_FINANCE_USER, collectionId: COLLECTION });
      };

      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      expect(repo.reconciliations.size).toBe(1);
      expect(result.created).toBe(false);
      expect(result.reconciliation.reconciledByUserId).toBe(OTHER_FINANCE_USER);
      expect(events.filter((e) => e.type === DeliveryEventType.CodReconciled)).toHaveLength(1);
    });
  });

  // ===========================================================================================
  // Events — §14
  // ===========================================================================================

  describe('events', () => {
    it('emits CodRemitted carrying all three amounts', async () => {
      repo.seed();
      await remit.execute(remitInput({ remittedAmount: 20_000 }));

      const event = events.find((e) => e.type === DeliveryEventType.CodRemitted);
      const payload = event?.payload as unknown as CodRemittedPayload;

      expect(event?.aggregateType).toBe('CodCollection');
      expect(event?.aggregateId).toBe(COLLECTION);
      // The pair that lets a consumer tell a clean handover from a short one without asking
      // Module 08 anything.
      expect(payload.expectedAmount).toBe(EXPECTED);
      expect(payload.collectedAmount).toBe(EXPECTED);
      expect(payload.remittedAmount).toBe(20_000);
      expect(payload.currency).toBe('ETB');
      expect(payload.reference).toBe('CASHDESK-2026-09-20-A');
      expect(payload.confirmedByUserId).toBe(FINANCE_USER);
      expect(typeof payload.remittedAt).toBe('string');
    });

    it('emits CodReconciled carrying the computed outcome', async () => {
      await remitted(EXPECTED, 20_000);
      await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reference: 'RUN-7',
      });

      const payload = events.find((e) => e.type === DeliveryEventType.CodReconciled)
        ?.payload as unknown as CodReconciledPayload;

      expect(payload.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);
      expect(payload.remittedAmount).toBe(20_000);
      expect(payload.remittanceReference).toBe('CASHDESK-2026-09-20-A');
      expect(payload.reconciliationReference).toBe('RUN-7');
      expect(payload.reconciledByUserId).toBe(FINANCE_USER);
    });

    it('carries no provider payload, secret or customer detail on either event', async () => {
      repo.seed({
        method: CodCollectionMethod.ELECTRONIC,
        providerReference: 'TXN-55512345',
      });
      await remit.execute(remitInput());
      await reconcile.execute({ actorUserId: FINANCE_USER, collectionId: COLLECTION });

      for (const event of events) {
        const serialized = JSON.stringify(event).toLowerCase();
        for (const forbidden of [
          'cvv',
          'pan',
          'telebirr',
          'nationalbank',
          'password',
          'token',
          'secret',
          'signature',
          'callback',
          'customer',
          'phone',
          'msisdn',
        ]) {
          expect(serialized).not.toContain(forbidden);
        }
      }
      // The one provider-adjacent value that *is* carried, deliberately: an opaque transaction
      // number a human quotes while reconciling.
      const payload = events.find((e) => e.type === DeliveryEventType.CodRemitted)
        ?.payload as unknown as CodRemittedPayload;
      expect(payload.providerReference).toBe('TXN-55512345');
    });

    it('emits nothing at all when a step is refused', async () => {
      repo.seed();

      await expect(
        reconcile.execute({ actorUserId: FINANCE_USER, collectionId: COLLECTION }),
      ).rejects.toThrow();

      expect(events).toHaveLength(0);
      expect(entries).toHaveLength(0);
    });
  });

  // ===========================================================================================
  // Audit — §20
  // ===========================================================================================

  describe('audit', () => {
    it('records the remittance with its actor, all three amounts and the variance', async () => {
      repo.seed();
      await remit.execute(remitInput({ remittedAmount: 20_000, note: 'One note missing.' }));

      const entry = entries.find((e) => e.action === 'DELIVERY_COD_REMITTED');

      expect(entry?.actorUserId).toBe(FINANCE_USER);
      expect(entry?.context).toMatchObject({
        expectedAmount: EXPECTED,
        collectedAmount: EXPECTED,
        remittedAmount: 20_000,
        variance: -4_500,
        outcome: CodRemittanceOutcome.Short,
        reference: 'CASHDESK-2026-09-20-A',
        status: 'REMITTED',
      });
    });

    it('records the reconciliation with its own actor and the finding', async () => {
      await remitted();
      await reconcile.execute({ actorUserId: OTHER_FINANCE_USER, collectionId: COLLECTION });

      const entry = entries.find((e) => e.action === 'DELIVERY_COD_RECONCILED');

      // A different operator from the one who confirmed the remittance, and the trail says so.
      expect(entry?.actorUserId).toBe(OTHER_FINANCE_USER);
      expect(entry?.context).toMatchObject({
        outcome: CodReconciliationOutcome.ACCEPTED,
        collectionVariance: 0,
        remittanceVariance: 0,
        status: 'RECONCILED',
      });
    });

    it('writes no successful state-change entry for a rejected attempt', async () => {
      await remitted();

      await expect(
        remit.execute(remitInput({ remittedAmount: 5, reference: 'DIFFERENT' })),
      ).rejects.toThrow();

      expect(entries.filter((e) => e.action === 'DELIVERY_COD_REMITTED')).toHaveLength(1);
    });
  });

  // ===========================================================================================
  // The finance read — §18, §19
  // ===========================================================================================

  describe('finance view', () => {
    it('answers every question §18 asks, from three rows', async () => {
      repo.seed();
      await remit.execute(remitInput({ remittedAmount: 20_000 }));
      await reconcile.execute({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        note: 'Short — chasing.',
      });

      const view = await list.byId(COLLECTION);

      expect(view.collection.expectedAmount).toBe(EXPECTED);
      expect(view.collection.collectedAmount).toBe(EXPECTED);
      expect(view.remittance?.remittedAmount).toBe(20_000);
      expect(view.collectionVariance).toBe(0);
      expect(view.remittanceVariance).toBe(-4_500);
      expect(view.hasDiscrepancy).toBe(true);
      expect(view.isOutstanding).toBe(false);
      expect(view.collection.driverId).toBe('driver-profile-1');
      expect(view.remittance?.confirmedByUserId).toBe(FINANCE_USER);
      expect(view.reconciliation?.reconciledByUserId).toBe(OTHER_FINANCE_USER);
      expect(view.remittance?.reference).toBe('CASHDESK-2026-09-20-A');
    });

    it('reports a not-yet-remitted collection as outstanding with a null remittance variance', async () => {
      repo.seed();

      const view = await list.byId(COLLECTION);

      // `null`, not `0`: zero would say "everything declared arrived", which is exactly what has
      // not been established about money nobody has handed over.
      expect(view.remittanceVariance).toBeNull();
      expect(view.isOutstanding).toBe(true);
      expect(view.remittance).toBeNull();
      expect(view.reconciliation).toBeNull();
    });

    it('filters by status, driver, currency and order', async () => {
      repo.seed();
      repo.seed({ id: 'cod-2', jobId: 'job-2', driverId: 'driver-profile-2', orderId: 'order-2' });
      await remit.execute(remitInput());

      await expect(
        list.execute({ status: CodCollectionStatus.REMITTED }).then((p) => p.total),
      ).resolves.toBe(1);
      await expect(
        list.execute({ driverId: 'driver-profile-2' }).then((p) => p.total),
      ).resolves.toBe(1);
      await expect(list.execute({ currency: 'etb' }).then((p) => p.total)).resolves.toBe(2);
      await expect(list.execute({ orderId: 'order-2' }).then((p) => p.total)).resolves.toBe(1);
    });

    it('groups a whole handover by its remittance reference', async () => {
      repo.seed();
      repo.seed({ id: 'cod-2', jobId: 'job-2' });
      repo.seed({ id: 'cod-3', jobId: 'job-3' });
      // One driver, one cash-desk visit, three collections under one handle. §19's batch, without
      // a batch table and without this module guessing a cadence.
      await remit.execute(remitInput({ reference: 'CASHDESK-A' }));
      await remit.execute(remitInput({ collectionId: 'cod-2', reference: 'CASHDESK-A' }));
      await remit.execute(remitInput({ collectionId: 'cod-3', reference: 'CASHDESK-B' }));

      const page = await list.execute({ remittanceReference: 'CASHDESK-A' });

      expect(page.total).toBe(2);
      expect(page.items.map((item) => item.collection.id).sort()).toEqual(['cod-2', COLLECTION]);
    });

    it('filters by collection period', async () => {
      repo.seed({ collectedAt: new Date('2026-09-01T00:00:00.000Z') });
      repo.seed({ id: 'cod-2', jobId: 'job-2', collectedAt: new Date('2026-09-30T00:00:00.000Z') });

      const page = await list.execute({
        from: new Date('2026-09-15T00:00:00.000Z'),
        to: new Date('2026-10-01T00:00:00.000Z'),
      });

      expect(page.total).toBe(1);
      expect(page.items[0].collection.id).toBe('cod-2');
    });

    it('answers NOT_FOUND for a collection that does not exist', async () => {
      await expect(list.byId('missing')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('never reports a driver earning, balance or payout alongside COD cash', async () => {
      repo.seed();
      await remit.execute(remitInput());

      const serialized = JSON.stringify(await list.byId(COLLECTION)).toLowerCase();

      // What a driver is owed and what a driver is holding are unrelated amounts. A view that
      // showed both would invite somebody to net them.
      for (const forbidden of ['earning', 'balance', 'payout', 'wallet', 'payable']) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  // ===========================================================================================
  // CASH and ELECTRONIC — §9, §10
  // ===========================================================================================

  describe('collection methods', () => {
    it('remits and reconciles a cash collection with no external verification at all', async () => {
      repo.seed({ method: CodCollectionMethod.CASH, providerReference: null });

      await remit.execute(remitInput());
      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      // No fabricated transaction id anywhere: cash was declared, handed over and counted, and the
      // record says exactly that and nothing more.
      expect(result.collection.providerReference).toBeNull();
      expect(result.remittance.reference).toBe('CASHDESK-2026-09-20-A');
      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.ACCEPTED);
    });

    it('preserves an electronic provider reference untouched through both steps', async () => {
      repo.seed({
        method: CodCollectionMethod.ELECTRONIC,
        providerReference: 'TXN-55512345',
      });

      await remit.execute(remitInput());
      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      // Carried as supplied evidence. Nothing verified it, nothing normalised it, and nothing in
      // this repository can check it against a provider yet.
      expect(result.collection.providerReference).toBe('TXN-55512345');
      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.ACCEPTED);
    });

    it('treats an electronic collection no differently from cash when reconciling', async () => {
      repo.seed({ method: CodCollectionMethod.ELECTRONIC, providerReference: 'TXN-1' });
      await remit.execute(remitInput({ remittedAmount: 20_000 }));

      const result = await reconcile.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
      });

      // The finding comes from the amounts, not from the rail. A module that scored `ELECTRONIC`
      // as more trustworthy would be inventing verification it cannot perform.
      expect(result.reconciliation.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);
    });
  });

  // ===========================================================================================
  // The policy in isolation
  // ===========================================================================================

  describe('CodCollectionPolicy', () => {
    it('allows a remittance only from COLLECTED', () => {
      expect(CodCollectionPolicy.isRemittanceAllowedIn(CodCollectionStatus.COLLECTED)).toBe(true);
      expect(CodCollectionPolicy.isRemittanceAllowedIn(CodCollectionStatus.REMITTED)).toBe(false);
      expect(CodCollectionPolicy.isRemittanceAllowedIn(CodCollectionStatus.RECONCILED)).toBe(false);
    });

    it('allows a reconciliation only from REMITTED', () => {
      expect(CodCollectionPolicy.isReconciliationAllowedIn(CodCollectionStatus.COLLECTED)).toBe(
        false,
      );
      expect(CodCollectionPolicy.isReconciliationAllowedIn(CodCollectionStatus.REMITTED)).toBe(
        true,
      );
      expect(CodCollectionPolicy.isReconciliationAllowedIn(CodCollectionStatus.RECONCILED)).toBe(
        false,
      );
    });

    it('classifies the three remittance outcomes', () => {
      expect(CodCollectionPolicy.classifyRemittance(100, 100)).toBe(CodRemittanceOutcome.Exact);
      expect(CodCollectionPolicy.classifyRemittance(100, 99)).toBe(CodRemittanceOutcome.Short);
      expect(CodCollectionPolicy.classifyRemittance(100, 101)).toBe(CodRemittanceOutcome.Over);
    });
  });

  // ===========================================================================================
  // Immutability — §8
  // ===========================================================================================

  describe('immutability', () => {
    it('exposes no mutator on either record', async () => {
      await remitted();
      await reconcile.execute({ actorUserId: FINANCE_USER, collectionId: COLLECTION });

      const remittance = CodRemittance.rehydrate(repo.remittances.get(COLLECTION)!);
      const reconciliation = CodReconciliation.rehydrate(repo.reconciliations.get(COLLECTION)!);

      for (const aggregate of [remittance, reconciliation]) {
        const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(aggregate));
        for (const name of methods) {
          expect(name).not.toMatch(/^(set|update|mark|change|overwrite|reset|delete)/);
        }
      }
    });

    it('refuses a reference longer than the stored column allows', () => {
      expect(() =>
        CodRemittance.record({
          id: 'r1',
          collectionId: COLLECTION,
          remittedAmount: 1,
          currency: 'ETB',
          reference: 'x'.repeat(129),
          confirmedByUserId: FINANCE_USER,
        }),
      ).toThrow();
    });
  });
});
