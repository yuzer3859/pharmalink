import { AuditService } from '../../../shared/audit/audit.service';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DomainEvent } from '../../../shared/events/domain-event';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { CodCollectionProps } from '../domain/entities/cod-collection.entity';
import {
  amountDeltaOf,
  CodCorrection,
  CodCorrectionProps,
} from '../domain/entities/cod-correction.entity';
import { CodDispute, CodDisputeProps } from '../domain/entities/cod-dispute.entity';
import { CodReconciliationProps } from '../domain/entities/cod-reconciliation.entity';
import { CodRemittanceProps } from '../domain/entities/cod-remittance.entity';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  CodCorrectionType,
  CodDisputeStatus,
  CodReconciliationOutcome,
} from '../domain/enums';
import { CodCorrectionRecordedPayload, DeliveryEventType } from '../domain/events';
import {
  CodCollectionPage,
  CodCollectionRecord,
  CodCollectionSearchCriteria,
  CodDisputePage,
  ICodCollectionRepository,
} from '../domain/repositories/cod-collection.repository';
import { ManageCodDisputeCommand } from './commands/manage-cod-dispute.command';
import { RecordCodCorrectionCommand } from './commands/record-cod-correction.command';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { ListCodCollectionsQuery } from './queries/list-cod-collections.query';

const COLLECTION = 'cod-collection-1';
const REMITTANCE = 'cod-remittance-1';
const RECONCILIATION = 'cod-reconciliation-1';
const EXPECTED = 24_500;
const FINANCE_USER = 'user-finance-1';
const OTHER_FINANCE_USER = 'user-finance-2';

/**
 * An in-memory COD store that **enforces the real constraints**, including the partial one.
 *
 * `cod_corrections.idempotencyKey` is unique here, and `cod_disputes` admits one row per collection
 * *while that row is open* — the same partiality PostgreSQL enforces. A fake that simply pushed
 * rows onto an array would pass every test in this file and prove nothing about either.
 */
class FakeCodRepository implements ICodCollectionRepository {
  readonly collections = new Map<string, CodCollectionProps>();
  readonly remittances = new Map<string, CodRemittanceProps>();
  readonly reconciliations = new Map<string, CodReconciliationProps>();
  readonly corrections: CodCorrectionProps[] = [];
  readonly disputes: CodDisputeProps[] = [];

  /** Runs once immediately before the next insert, to open the race window a rival would win. */
  onInsertCorrection: (() => Promise<void>) | null = null;
  onInsertDispute: (() => Promise<void>) | null = null;
  onResolveDispute: (() => Promise<void>) | null = null;

  seedCollection(overrides: Partial<CodCollectionProps> = {}): CodCollectionProps {
    const collection: CodCollectionProps = {
      id: COLLECTION,
      jobId: 'job-1',
      orderId: 'order-1',
      fulfillmentId: 'fulfillment-1',
      driverId: 'driver-profile-1',
      expectedAmount: EXPECTED,
      collectedAmount: 20_000,
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

  seedRemittance(overrides: Partial<CodRemittanceProps> = {}): CodRemittanceProps {
    const remittance: CodRemittanceProps = {
      id: REMITTANCE,
      collectionId: COLLECTION,
      remittedAmount: 20_000,
      currency: 'ETB',
      reference: 'CASHDESK-A',
      note: null,
      confirmedByUserId: FINANCE_USER,
      remittedAt: new Date('2026-09-21T09:00:00.000Z'),
      recordedAt: new Date('2026-09-21T09:05:00.000Z'),
      ...overrides,
    };
    this.remittances.set(remittance.collectionId, remittance);
    return remittance;
  }

  seedReconciliation(overrides: Partial<CodReconciliationProps> = {}): CodReconciliationProps {
    const reconciliation: CodReconciliationProps = {
      id: RECONCILIATION,
      collectionId: COLLECTION,
      outcome: CodReconciliationOutcome.DISCREPANCY,
      reference: null,
      note: null,
      reconciledByUserId: FINANCE_USER,
      reconciledAt: new Date('2026-09-22T09:00:00.000Z'),
      ...overrides,
    };
    this.reconciliations.set(reconciliation.collectionId, reconciliation);
    return reconciliation;
  }

  // --- the lifecycle half, unused here -------------------------------------------------------

  async insert(): Promise<CodCollectionProps | null> {
    throw new Error('not used in this suite');
  }

  async findByJobId(): Promise<CodCollectionProps | null> {
    throw new Error('not used in this suite');
  }

  async advanceToRemitted(): Promise<boolean> {
    throw new Error('not used in this suite');
  }

  async advanceToReconciled(): Promise<boolean> {
    throw new Error('not used in this suite');
  }

  async insertRemittance(): Promise<CodRemittanceProps | null> {
    throw new Error('not used in this suite');
  }

  async insertReconciliation(): Promise<CodReconciliationProps | null> {
    throw new Error('not used in this suite');
  }

  // --- what this suite drives ----------------------------------------------------------------

  async findById(collectionId: string): Promise<CodCollectionProps | null> {
    return this.collections.get(collectionId) ?? null;
  }

  async findRemittanceByCollectionId(collectionId: string): Promise<CodRemittanceProps | null> {
    return this.remittances.get(collectionId) ?? null;
  }

  async findReconciliationByCollectionId(
    collectionId: string,
  ): Promise<CodReconciliationProps | null> {
    return this.reconciliations.get(collectionId) ?? null;
  }

  async insertCorrection(correction: CodCorrectionProps): Promise<CodCorrectionProps | null> {
    if (this.onInsertCorrection) {
      const hook = this.onInsertCorrection;
      this.onInsertCorrection = null;
      await hook();
    }
    if (this.corrections.some((row) => row.idempotencyKey === correction.idempotencyKey)) {
      return null;
    }
    this.corrections.push(correction);
    return correction;
  }

  async findCorrectionByIdempotencyKey(key: string): Promise<CodCorrectionProps | null> {
    return this.corrections.find((row) => row.idempotencyKey === key) ?? null;
  }

  async listCorrections(collectionId: string): Promise<CodCorrectionProps[]> {
    return this.corrections.filter((row) => row.collectionId === collectionId);
  }

  async insertDispute(dispute: CodDisputeProps): Promise<CodDisputeProps | null> {
    if (this.onInsertDispute) {
      const hook = this.onInsertDispute;
      this.onInsertDispute = null;
      await hook();
    }
    // The **partial** index: one open dispute per collection, and no constraint at all on how many
    // resolved ones sit behind it.
    const openExists = this.disputes.some(
      (row) => row.collectionId === dispute.collectionId && row.status === CodDisputeStatus.OPEN,
    );
    if (openExists) {
      return null;
    }
    this.disputes.push(dispute);
    return dispute;
  }

  async findDisputeById(disputeId: string): Promise<CodDisputeProps | null> {
    return this.disputes.find((row) => row.id === disputeId) ?? null;
  }

  async findOpenDispute(collectionId: string): Promise<CodDisputeProps | null> {
    return (
      this.disputes.find(
        (row) => row.collectionId === collectionId && row.status === CodDisputeStatus.OPEN,
      ) ?? null
    );
  }

  async listDisputes(collectionId: string): Promise<CodDisputeProps[]> {
    return this.disputes.filter((row) => row.collectionId === collectionId);
  }

  async searchDisputes(): Promise<CodDisputePage> {
    throw new Error('not used in this suite');
  }

  async resolveDispute(
    disputeId: string,
    resolution: { resolvedByUserId: string; resolvedAt: Date; resolutionNote: string | null },
  ): Promise<boolean> {
    if (this.onResolveDispute) {
      const hook = this.onResolveDispute;
      this.onResolveDispute = null;
      await hook();
    }
    const index = this.disputes.findIndex(
      (row) => row.id === disputeId && row.status === CodDisputeStatus.OPEN,
    );
    if (index === -1) {
      return false;
    }
    this.disputes[index] = {
      ...this.disputes[index],
      status: CodDisputeStatus.RESOLVED,
      resolvedByUserId: resolution.resolvedByUserId,
      resolvedAt: resolution.resolvedAt,
      resolutionNote: resolution.resolutionNote,
    };
    return true;
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
      corrections: this.corrections.filter((row) => row.collectionId === collectionId),
      disputes: this.disputes.filter((row) => row.collectionId === collectionId),
    };
  }

  async search(criteria: CodCollectionSearchCriteria): Promise<CodCollectionPage> {
    const rows = [...this.collections.values()];
    return {
      items: rows.map((collection) => ({
        collection,
        remittance: this.remittances.get(collection.id) ?? null,
        reconciliation: this.reconciliations.get(collection.id) ?? null,
        corrections: this.corrections.filter((row) => row.collectionId === collection.id),
        disputes: this.disputes.filter((row) => row.collectionId === collection.id),
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

describe('COD corrections and disputes', () => {
  let repo: FakeCodRepository;
  let entries: { action: string; actorUserId?: string | null; context: Record<string, unknown> }[];
  let events: DomainEvent<Record<string, unknown>>[];
  let correct: RecordCodCorrectionCommand;
  let disputes: ManageCodDisputeCommand;
  let list: ListCodCollectionsQuery;

  beforeEach(() => {
    repo = new FakeCodRepository();
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

    correct = new RecordCodCorrectionCommand(repo, fakeUow, audit, outbox);
    disputes = new ManageCodDisputeCommand(repo, fakeUow, audit);
    list = new ListCodCollectionsQuery(repo);
  });

  /** The ordinary case: the operator keyed 20,000 and the driver actually handed over 24,500. */
  function recordingMistake(overrides: Record<string, unknown> = {}) {
    return {
      actorUserId: FINANCE_USER,
      collectionId: COLLECTION,
      type: CodCorrectionType.RECORDING_MISTAKE,
      originalAmount: 20_000,
      correctedAmount: EXPECTED,
      reason: 'Cash desk recount: the driver handed over the full amount.',
      idempotencyKey: 'correction-key-1',
      ...overrides,
    } as Parameters<RecordCodCorrectionCommand['execute']>[0];
  }

  // ===========================================================================================
  // History stays exactly as it was written — §1, §4, §6
  // ===========================================================================================

  describe('immutable history', () => {
    it('leaves the collection byte-for-byte unchanged', async () => {
      const before = { ...repo.seedCollection() };

      await correct.execute(recordingMistake());

      expect(repo.collections.get(COLLECTION)).toEqual(before);
    });

    it('leaves the remittance and the reconciliation unchanged', async () => {
      repo.seedCollection();
      const remittance = { ...repo.seedRemittance() };
      const reconciliation = { ...repo.seedReconciliation() };

      await correct.execute(
        recordingMistake({ remittanceId: REMITTANCE, originalAmount: 20_000, correctedAmount: 1 }),
      );
      await correct.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        type: CodCorrectionType.RECONCILIATION_MISTAKE,
        reconciliationId: RECONCILIATION,
        reason: 'Checked against the wrong deposit slip.',
        idempotencyKey: 'correction-key-2',
      });

      expect(repo.remittances.get(COLLECTION)).toEqual(remittance);
      expect(repo.reconciliations.get(COLLECTION)).toEqual(reconciliation);
    });

    it('does not move the collection through its lifecycle', async () => {
      repo.seedCollection({ status: CodCollectionStatus.RECONCILED });

      await correct.execute(recordingMistake());
      await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Recount needed.',
      });

      const row = repo.collections.get(COLLECTION);
      expect(row?.status).toBe(CodCollectionStatus.RECONCILED);
      expect(row?.collectedAmount).toBe(20_000);
    });

    it('exposes no mutator on a correction', async () => {
      repo.seedCollection();
      const { correction } = await correct.execute(recordingMistake());

      const methods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(CodCorrection.rehydrate(correction)),
      );
      for (const name of methods) {
        expect(name).not.toMatch(/^(set|update|mark|change|overwrite|reset|delete|apply)/);
      }
    });

    it('answers a mistaken correction with another correction, never an edit', async () => {
      repo.seedCollection();
      await correct.execute(recordingMistake());

      await correct.execute(
        recordingMistake({
          originalAmount: EXPECTED,
          correctedAmount: 22_000,
          reason: 'The recount above was itself wrong.',
          idempotencyKey: 'correction-key-2',
        }),
      );

      // Two rows, in order. A correction is a list rather than a slot, which is what keeps the
      // whole trail readable after somebody corrects a correction.
      expect(repo.corrections).toHaveLength(2);
      expect(repo.corrections.map((row) => row.correctedAmount)).toEqual([EXPECTED, 22_000]);
    });
  });

  // ===========================================================================================
  // The correction itself — §2, §4
  // ===========================================================================================

  describe('correction records', () => {
    it('records the type, both values, the reason, the actor and the time', async () => {
      repo.seedCollection();

      const result = await correct.execute(recordingMistake());

      expect(result.created).toBe(true);
      expect(result.correction).toMatchObject({
        collectionId: COLLECTION,
        type: CodCorrectionType.RECORDING_MISTAKE,
        originalAmount: 20_000,
        correctedAmount: EXPECTED,
        reason: 'Cash desk recount: the driver handed over the full amount.',
        createdByUserId: FINANCE_USER,
      });
      expect(result.correction.createdAt).toBeInstanceOf(Date);
      expect(result.amountDelta).toBe(4_500);
    });

    it('records a reference correction with both references and no amount', async () => {
      repo.seedCollection();
      repo.seedRemittance();

      const result = await correct.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        remittanceId: REMITTANCE,
        type: CodCorrectionType.REFERENCE_CORRECTION,
        originalReference: 'CASHDESK-A',
        correctedReference: 'CASHDESK-B',
        reason: 'Slip number transposed.',
        idempotencyKey: 'correction-key-ref',
      });

      expect(result.correction.correctedReference).toBe('CASHDESK-B');
      expect(result.correction.originalAmount).toBeNull();
      expect(result.amountDelta).toBeNull();
    });

    it('records an administrative adjustment carrying no value at all', async () => {
      repo.seedCollection();

      const result = await correct.execute({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        type: CodCorrectionType.ADMINISTRATIVE_ADJUSTMENT,
        reason: 'Driver reported the customer paid in two instalments at the door.',
        idempotencyKey: 'correction-key-admin',
      });

      expect(result.correction.originalAmount).toBeNull();
      expect(result.correction.correctedReference).toBeNull();
    });

    it('refuses a recording mistake with only one half of the pair', async () => {
      repo.seedCollection();

      await expect(
        correct.execute(recordingMistake({ correctedAmount: null })),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(repo.corrections).toHaveLength(0);
    });

    it('refuses a correction that changes nothing', async () => {
      repo.seedCollection();

      await expect(
        correct.execute(recordingMistake({ correctedAmount: 20_000 })),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('refuses an amount on an administrative adjustment', async () => {
      repo.seedCollection();

      // The value that would turn a note of record into a write-off.
      await expect(
        correct.execute({
          actorUserId: FINANCE_USER,
          collectionId: COLLECTION,
          type: CodCorrectionType.ADMINISTRATIVE_ADJUSTMENT,
          correctedAmount: 0,
          originalAmount: 20_000,
          reason: 'Writing the shortfall off.',
          idempotencyKey: 'correction-key-writeoff',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
      expect(repo.corrections).toHaveLength(0);
    });

    it('refuses a correction with no reason', async () => {
      repo.seedCollection();

      await expect(correct.execute(recordingMistake({ reason: '   ' }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
    });

    it('refuses a reconciliation-mistake correction that names no reconciliation', async () => {
      repo.seedCollection();

      await expect(
        correct.execute({
          actorUserId: FINANCE_USER,
          collectionId: COLLECTION,
          type: CodCorrectionType.RECONCILIATION_MISTAKE,
          reason: 'Wrong evidence.',
          idempotencyKey: 'correction-key-bad',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('refuses a correction naming a record that is not this collection’s', async () => {
      repo.seedCollection();
      repo.seedRemittance();

      await expect(
        correct.execute(recordingMistake({ remittanceId: 'some-other-remittance' })),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(repo.corrections).toHaveLength(0);
    });

    it('refuses a correction naming a record that does not exist yet', async () => {
      repo.seedCollection();

      await expect(
        correct.execute({
          actorUserId: FINANCE_USER,
          collectionId: COLLECTION,
          type: CodCorrectionType.RECONCILIATION_MISTAKE,
          reconciliationId: RECONCILIATION,
          reason: 'Nothing has been reconciled.',
          idempotencyKey: 'correction-key-missing',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
    });

    it('refuses a correction against a collection that does not exist', async () => {
      await expect(
        correct.execute(recordingMistake({ collectionId: 'missing' })),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('has no correction type that decides who absorbs a shortfall', () => {
      // The vocabulary is the guarantee. Every value names a mistake in the *record*.
      expect(Object.values(CodCorrectionType).sort()).toEqual([
        'ADMINISTRATIVE_ADJUSTMENT',
        'RECONCILIATION_MISTAKE',
        'RECORDING_MISTAKE',
        'REFERENCE_CORRECTION',
      ]);
    });
  });

  // ===========================================================================================
  // The discrepancy survives — §6
  // ===========================================================================================

  describe('discrepancy preservation', () => {
    it('still reports the original shortfall after a correction restates it', async () => {
      repo.seedCollection();
      const before = await list.byId(COLLECTION);
      expect(before.collectionVariance).toBe(-4_500);

      await correct.execute(recordingMistake());

      const after = await list.byId(COLLECTION);
      // The correction says the record should have read 24,500. The record still reads 20,000, and
      // the variance still reads −4,500 — `original fact + correction` is the history.
      expect(after.collectionVariance).toBe(-4_500);
      expect(after.hasDiscrepancy).toBe(true);
      expect(after.collection.collectedAmount).toBe(20_000);
      expect(after.corrections).toHaveLength(1);
      expect(amountDeltaOf(after.corrections[0])).toBe(4_500);
    });

    it('still reports the shortfall after a dispute is opened and resolved', async () => {
      repo.seedCollection();
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Driver says they handed over the full amount.',
      });
      await disputes.resolve({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recount agreed with the driver.',
      });

      const view = await list.byId(COLLECTION);
      expect(view.collectionVariance).toBe(-4_500);
      expect(view.hasDiscrepancy).toBe(true);
    });
  });

  // ===========================================================================================
  // Disputes — §5
  // ===========================================================================================

  describe('disputes', () => {
    it('opens a dispute with its reason, opener and time', async () => {
      repo.seedCollection();

      const result = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short by 4,500 at the cash desk.',
      });

      expect(result.created).toBe(true);
      expect(result.dispute).toMatchObject({
        collectionId: COLLECTION,
        status: CodDisputeStatus.OPEN,
        openedByUserId: FINANCE_USER,
        reason: 'Short by 4,500 at the cash desk.',
        resolvedByUserId: null,
        resolvedAt: null,
        resolutionNote: null,
      });
    });

    it('resolves it, naming a different operator and their conclusion', async () => {
      repo.seedCollection();
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short by 4,500.',
      });

      const result = await disputes.resolve({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted; the shortfall was a miscount at the desk.',
      });

      expect(result.dispute).toMatchObject({
        status: CodDisputeStatus.RESOLVED,
        openedByUserId: FINANCE_USER,
        resolvedByUserId: OTHER_FINANCE_USER,
        resolutionNote: 'Recounted; the shortfall was a miscount at the desk.',
      });
      expect(result.dispute.resolvedAt).toBeInstanceOf(Date);
    });

    it('can be opened at any stage, including before anything is reconciled', async () => {
      repo.seedCollection({ status: CodCollectionStatus.COLLECTED });

      const result = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'The driver has not turned up with the cash.',
      });

      expect(result.created).toBe(true);
    });

    it('allows a genuinely new dispute once the earlier one is resolved', async () => {
      repo.seedCollection();
      const first = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'First question.',
      });
      await disputes.resolve({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: first.dispute.id,
        resolutionNote: 'Closed.',
      });

      const second = await disputes.open({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Second question, months later.',
      });

      // The partiality of the index, tested: one *open* dispute, not one dispute ever.
      expect(second.created).toBe(true);
      expect(repo.disputes).toHaveLength(2);
    });

    it('refuses to open a dispute with no reason', async () => {
      repo.seedCollection();

      await expect(
        disputes.open({ actorUserId: FINANCE_USER, collectionId: COLLECTION, reason: '  ' }),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    });

    it('refuses a dispute id belonging to another collection', async () => {
      repo.seedCollection();
      repo.seedCollection({ id: 'cod-collection-2', jobId: 'job-2' });
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: 'cod-collection-2',
        reason: 'Elsewhere.',
      });

      await expect(
        disputes.resolve({
          actorUserId: FINANCE_USER,
          collectionId: COLLECTION,
          disputeId: dispute.id,
        }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('has no resolution outcome that decides who pays', () => {
      // Two states, and the conclusion is free text. An enum here would want RECOVERED or
      // WRITTEN_OFF, and the platform would have decided who pays by way of a status value.
      expect(Object.values(CodDisputeStatus).sort()).toEqual(['OPEN', 'RESOLVED']);
    });

    it('refuses a resolved dispute that does not name who resolved it', () => {
      expect(() =>
        CodDispute.rehydrate({
          id: 'dispute-1',
          collectionId: COLLECTION,
          reason: 'x',
          status: CodDisputeStatus.RESOLVED,
          openedByUserId: FINANCE_USER,
          openedAt: new Date(),
          resolvedByUserId: null,
          resolvedAt: null,
          resolutionNote: null,
        }),
      ).toThrow();
    });
  });

  // ===========================================================================================
  // Idempotency and concurrency — §9, §10
  // ===========================================================================================

  describe('idempotency', () => {
    it('replays an identical correction without a second row, audit entry or event', async () => {
      repo.seedCollection();
      await correct.execute(recordingMistake());
      const auditCount = entries.length;
      const eventCount = events.length;

      const replay = await correct.execute(recordingMistake());

      expect(replay.created).toBe(false);
      expect(repo.corrections).toHaveLength(1);
      expect(entries).toHaveLength(auditCount);
      expect(events).toHaveLength(eventCount);
    });

    it('refuses a different correction under the same replay key', async () => {
      repo.seedCollection();
      await correct.execute(recordingMistake());

      await expect(
        correct.execute(recordingMistake({ correctedAmount: 30_000 })),
      ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
      expect(repo.corrections).toHaveLength(1);
      expect(repo.corrections[0].correctedAmount).toBe(EXPECTED);
    });

    it('converges two concurrent corrections under one key', async () => {
      repo.seedCollection();
      // The rival commits inside the first one's transaction, exactly where a second API node
      // would. Only the unique index can settle it.
      repo.onInsertCorrection = async () => {
        await correct.execute(recordingMistake({ actorUserId: OTHER_FINANCE_USER }));
      };

      const result = await correct.execute(recordingMistake());

      expect(repo.corrections).toHaveLength(1);
      expect(result.created).toBe(false);
      expect(result.correction.createdByUserId).toBe(OTHER_FINANCE_USER);
      expect(events).toHaveLength(1);
    });

    it('converges two concurrent dispute openings on one dispute', async () => {
      repo.seedCollection();
      repo.onInsertDispute = async () => {
        await disputes.open({
          actorUserId: OTHER_FINANCE_USER,
          collectionId: COLLECTION,
          reason: 'Raised by somebody else first.',
        });
      };

      const result = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short by 4,500.',
      });

      expect(repo.disputes).toHaveLength(1);
      expect(result.created).toBe(false);
      expect(result.dispute.openedByUserId).toBe(OTHER_FINANCE_USER);
    });

    it('replays a second, matching resolution and refuses a different one', async () => {
      repo.seedCollection();
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short.',
      });
      await disputes.resolve({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted.',
      });

      const replay = await disputes.resolve({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted.',
      });
      expect(replay.created).toBe(false);
      expect(replay.dispute.resolvedByUserId).toBe(FINANCE_USER);

      await expect(
        disputes.resolve({
          actorUserId: OTHER_FINANCE_USER,
          collectionId: COLLECTION,
          disputeId: dispute.id,
          resolutionNote: 'Actually the driver owes it.',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
      expect(repo.disputes[0].resolutionNote).toBe('Recounted.');
    });

    it('converges two concurrent resolutions on one conclusion', async () => {
      repo.seedCollection();
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short.',
      });
      repo.onResolveDispute = async () => {
        await disputes.resolve({
          actorUserId: OTHER_FINANCE_USER,
          collectionId: COLLECTION,
          disputeId: dispute.id,
          resolutionNote: 'Recounted.',
        });
      };

      const result = await disputes.resolve({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted.',
      });

      expect(result.created).toBe(false);
      expect(repo.disputes[0].resolvedByUserId).toBe(OTHER_FINANCE_USER);
      expect(
        entries.filter((entry) => entry.action === 'DELIVERY_COD_DISPUTE_RESOLVED'),
      ).toHaveLength(1);
    });
  });

  // ===========================================================================================
  // Events — §8
  // ===========================================================================================

  describe('events', () => {
    it('emits CodCorrectionRecorded once, carrying both the original and the corrected value', async () => {
      repo.seedCollection();

      await correct.execute(recordingMistake());

      const event = events.find((e) => e.type === DeliveryEventType.CodCorrectionRecorded);
      const payload = event?.payload as unknown as CodCorrectionRecordedPayload;

      expect(events).toHaveLength(1);
      expect(event?.aggregateType).toBe('CodCollection');
      expect(event?.aggregateId).toBe(COLLECTION);
      // Both halves. A payload carrying only the corrected value would be indistinguishable from
      // a rewrite, which is the one thing this whole work exists to avoid looking like.
      expect(payload.originalAmount).toBe(20_000);
      expect(payload.correctedAmount).toBe(EXPECTED);
      expect(payload.type).toBe(CodCorrectionType.RECORDING_MISTAKE);
      expect(payload.createdByUserId).toBe(FINANCE_USER);
      expect(payload.currency).toBe('ETB');
      expect(typeof payload.createdAt).toBe('string');
    });

    it('emits no event for a dispute, opened or resolved', async () => {
      repo.seedCollection();
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short.',
      });
      await disputes.resolve({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted.',
      });

      // Nothing outside this module acts on a dispute, and an event because a record exists is
      // exactly what §8 rules out. The audit trail is where both operations are durable.
      expect(events).toHaveLength(0);
      expect(entries.map((entry) => entry.action)).toEqual([
        'DELIVERY_COD_DISPUTE_OPENED',
        'DELIVERY_COD_DISPUTE_RESOLVED',
      ]);
    });

    it('carries no provider secret or customer detail', async () => {
      repo.seedCollection({
        method: CodCollectionMethod.ELECTRONIC,
        providerReference: 'TXN-55512345',
      });

      await correct.execute(recordingMistake());

      const serialized = JSON.stringify(events[0]).toLowerCase();
      for (const forbidden of [
        'cvv',
        'pan',
        'telebirr',
        'password',
        'token',
        'secret',
        'signature',
        'callback',
        'customer',
        'phone',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('emits nothing when a correction is refused', async () => {
      repo.seedCollection();

      await expect(
        correct.execute(recordingMistake({ correctedAmount: 20_000 })),
      ).rejects.toThrow();

      expect(events).toHaveLength(0);
      expect(entries).toHaveLength(0);
    });
  });

  // ===========================================================================================
  // Audit — §17's "audit trail is complete"
  // ===========================================================================================

  describe('audit', () => {
    it('records the correction with its actor, both values and the reason', async () => {
      repo.seedCollection();

      await correct.execute(recordingMistake());

      const entry = entries.find((e) => e.action === 'DELIVERY_COD_CORRECTION_RECORDED');
      expect(entry?.actorUserId).toBe(FINANCE_USER);
      expect(entry?.context).toMatchObject({
        type: CodCorrectionType.RECORDING_MISTAKE,
        originalAmount: 20_000,
        correctedAmount: EXPECTED,
        amountDelta: 4_500,
        driverId: 'driver-profile-1',
        reason: 'Cash desk recount: the driver handed over the full amount.',
      });
    });

    it('records both dispute actors and the untouched figures', async () => {
      repo.seedCollection();
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short.',
      });
      await disputes.resolve({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted.',
      });

      const opened = entries.find((e) => e.action === 'DELIVERY_COD_DISPUTE_OPENED');
      const resolved = entries.find((e) => e.action === 'DELIVERY_COD_DISPUTE_RESOLVED');

      expect(opened?.actorUserId).toBe(FINANCE_USER);
      expect(resolved?.actorUserId).toBe(OTHER_FINANCE_USER);
      expect(resolved?.context).toMatchObject({
        openedByUserId: FINANCE_USER,
        resolutionNote: 'Recounted.',
        // Stated so the trail shows the money was not touched by the closing.
        expectedAmount: EXPECTED,
        collectedAmount: 20_000,
      });
    });

    it('writes no successful entry for a rejected attempt', async () => {
      repo.seedCollection();
      await correct.execute(recordingMistake());

      await expect(
        correct.execute(recordingMistake({ correctedAmount: 30_000 })),
      ).rejects.toThrow();

      expect(
        entries.filter((e) => e.action === 'DELIVERY_COD_CORRECTION_RECORDED'),
      ).toHaveLength(1);
    });
  });

  // ===========================================================================================
  // The finance read — §11
  // ===========================================================================================

  describe('finance visibility', () => {
    it('shows the three records, the discrepancy, the corrections and the disputes together', async () => {
      repo.seedCollection();
      repo.seedRemittance();
      repo.seedReconciliation();
      await correct.execute(recordingMistake({ remittanceId: REMITTANCE }));
      const { dispute } = await disputes.open({
        actorUserId: FINANCE_USER,
        collectionId: COLLECTION,
        reason: 'Short by 4,500.',
      });
      await disputes.resolve({
        actorUserId: OTHER_FINANCE_USER,
        collectionId: COLLECTION,
        disputeId: dispute.id,
        resolutionNote: 'Recounted.',
      });

      const view = await list.byId(COLLECTION);

      expect(view.collection.expectedAmount).toBe(EXPECTED);
      expect(view.collection.collectedAmount).toBe(20_000);
      expect(view.remittance?.remittedAmount).toBe(20_000);
      expect(view.reconciliation?.outcome).toBe(CodReconciliationOutcome.DISCREPANCY);
      expect(view.collectionVariance).toBe(-4_500);
      expect(view.corrections).toHaveLength(1);
      expect(view.corrections[0].createdByUserId).toBe(FINANCE_USER);
      expect(view.disputes).toHaveLength(1);
      expect(view.disputes[0].resolvedByUserId).toBe(OTHER_FINANCE_USER);
    });

    it('never joins driver earnings into the COD view', async () => {
      repo.seedCollection();
      await correct.execute(recordingMistake());

      const serialized = JSON.stringify(await list.byId(COLLECTION)).toLowerCase();
      for (const forbidden of ['earning', 'payout', 'wallet', 'balance', 'payable']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('lists corrections on the page read as well as the detail read', async () => {
      repo.seedCollection();
      await correct.execute(recordingMistake());

      const page = await list.execute({});

      expect(page.items[0].corrections).toHaveLength(1);
    });
  });
});
