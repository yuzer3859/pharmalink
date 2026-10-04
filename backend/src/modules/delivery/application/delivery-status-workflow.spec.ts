import { AuditService } from '../../../shared/audit/audit.service';
import { DomainEvent } from '../../../shared/events/domain-event';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { DeliveryJob, DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import { DeliveryActorType, DeliveryJobStatus, DriverAvailability } from '../domain/enums';
import { DeliveryEventType } from '../domain/events';
import {
  DeliveryJobStateExpectation,
  DeliveryStatusHistoryEntry,
  DeliveryStatusHistoryRecord,
  IDeliveryJobRepository,
} from '../domain/repositories/delivery-job.repository';
import { IDriverProfileRepository } from '../domain/repositories/driver-profile.repository';
import { AdvanceDeliveryJobCommand } from './commands/advance-delivery-job.command';
import { CancelDeliveryJobCommand } from './commands/cancel-delivery-job.command';
import { IIdentityPort } from './ports/outbound/identity.port';
import { IConfigPort } from '../../../shared/config/config.port';
import { ProofOfDeliveryProps } from '../domain/entities/proof-of-delivery.entity';
import { IProofOfDeliveryRepository } from '../domain/repositories/proof-of-delivery.repository';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { GetDeliveryJobStatusQuery } from './queries/get-delivery-job-status.query';
import { DriverEarningProps } from '../domain/entities/driver-earning.entity';
import { EarningStatus } from '../domain/enums';
import { IDriverEarningRepository } from '../domain/repositories/driver-earning.repository';

const DRIVER_USER = 'user-driver-1';
const DRIVER_PROFILE = 'driver-profile-1';
const OTHER_PROFILE = 'driver-profile-2';
const ORDER = 'order-1';
import { CodCollectionProps } from '../domain/entities/cod-collection.entity';
import { CodCollectionMethod, CodCollectionStatus } from '../domain/enums';
import { CodCorrectionProps } from '../domain/entities/cod-correction.entity';
import { CodDisputeProps } from '../domain/entities/cod-dispute.entity';
import { CodReconciliationProps } from '../domain/entities/cod-reconciliation.entity';
import { CodRemittanceProps } from '../domain/entities/cod-remittance.entity';
import {
  CodCollectionPage,
  CodCollectionRecord,
  CodDisputePage,
  ICodCollectionRepository,
} from '../domain/repositories/cod-collection.repository';

/**
 * An in-memory job repository whose `updateState` is a **real** compare-and-set, with no `await`
 * between the check and the write — the same discipline the dispatch and creation specs apply, so
 * a fake that yielded there cannot make a genuine concurrency bug pass.
 */
class FakeJobRepository implements Partial<IDeliveryJobRepository> {
  readonly jobs = new Map<string, DeliveryJobProps>();
  readonly history: DeliveryStatusHistoryRecord[] = [];
  /** Runs inside `updateState`, before the compare-and-set, to interleave a competing writer. */
  onUpdate: (() => Promise<void>) | null = null;
  private seq = 0;

  seed(job: DeliveryJobProps): void {
    this.jobs.set(job.id, { ...job });
  }

  async findById(id: string): Promise<DeliveryJobProps | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async findByOrderId(orderId: string): Promise<DeliveryJobProps[]> {
    return [...this.jobs.values()].filter((j) => j.orderId === orderId).map((j) => ({ ...j }));
  }

  async updateState(
    id: string,
    expected: DeliveryJobStateExpectation,
    update: { status: DeliveryJobStatus; pickedUpAt?: Date | null; deliveredAt?: Date | null },
  ): Promise<DeliveryJobProps | null> {
    if (this.onUpdate) {
      const hook = this.onUpdate;
      this.onUpdate = null;
      await hook();
    }
    // Atomic from here: no `await` between reading the row and writing it. Both halves of the
    // expectation are compared, exactly as the `WHERE` clause does — so a test that interleaves a
    // reassignment fails here too, rather than passing on a fake that only checks the status.
    const job = this.jobs.get(id);
    if (!job || job.status !== expected.status) {
      return null;
    }
    if (
      expected.assignedDriverId !== undefined &&
      job.assignedDriverId !== expected.assignedDriverId
    ) {
      return null;
    }
    const next: DeliveryJobProps = {
      ...job,
      status: update.status,
      ...(update.pickedUpAt !== undefined ? { pickedUpAt: update.pickedUpAt } : {}),
      ...(update.deliveredAt !== undefined ? { deliveredAt: update.deliveredAt } : {}),
      updatedAt: new Date(),
    };
    this.jobs.set(id, next);
    return { ...next };
  }

  async appendStatusHistory(entry: DeliveryStatusHistoryEntry): Promise<void> {
    this.seq += 1;
    this.history.push({
      ...entry,
      id: `history-${this.seq}`,
      // Distinct, increasing timestamps so ordering is testable without sleeping.
      createdAt: new Date(Date.UTC(2026, 8, 18, 8, 0, this.seq)),
    });
  }

  async listStatusHistory(jobId: string): Promise<DeliveryStatusHistoryRecord[]> {
    return this.history.filter((h) => h.jobId === jobId).map((h) => ({ ...h }));
  }
}

class FakeProfileRepository implements Partial<IDriverProfileRepository> {
  profile: DriverProfileProps | null = baseProfile();

  async findByUserId(userId: string): Promise<DriverProfileProps | null> {
    return this.profile && this.profile.userId === userId ? this.profile : null;
  }
}

/**
 * Fixture times are **relative to the clock**, not absolute.
 *
 * The aggregate enforces real chronology — a delivery cannot precede its own pickup — and the
 * commands stamp `new Date()`. A fixture pinned to an absolute date drifts past the clock and
 * starts failing invariants that have nothing to do with what is being tested.
 */
const HOURS_AGO = (n: number): Date => new Date(Date.now() - n * 3_600_000);

function baseProfile(): DriverProfileProps {
  return {
    id: DRIVER_PROFILE,
    userId: DRIVER_USER,
    vehicle: null,
    serviceArea: null,
    availability: DriverAvailability.ONLINE,
    shiftStartedAt: HOURS_AGO(4),
    lastOnlineAt: HOURS_AGO(4),
    maxConcurrent: null,
    lastLocation: null,
    lastLocationAt: null,
    createdAt: HOURS_AGO(4),
    updatedAt: HOURS_AGO(4),
  };
}

function job(
  status: DeliveryJobStatus,
  overrides: Partial<DeliveryJobProps> = {},
): DeliveryJobProps {
  const base = DeliveryJob.create({
    id: 'job-1',
    orderId: ORDER,
    fulfillmentId: 'fulfillment-1',
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
  }).toProps();
  // Built directly rather than driven through transitions: these are *starting points*, and the
  // transitions themselves are what the tests are about.
  return {
    ...base,
    status,
    // CREATED and OFFERED have no driver at all — the aggregate refuses a job that names one
    // before it is assigned, because it would make an unoffered job look already taken.
    assignedDriverId: hasDriver(status) ? DRIVER_PROFILE : null,
    ...(afterPickup(status) ? { pickedUpAt: HOURS_AGO(2) } : {}),
    ...overrides,
  };
}

function hasDriver(status: DeliveryJobStatus): boolean {
  const unassigned: DeliveryJobStatus[] = [
    DeliveryJobStatus.CREATED,
    DeliveryJobStatus.OFFERED,
    DeliveryJobStatus.REASSIGNING,
  ];
  return !unassigned.includes(status);
}

function afterPickup(status: DeliveryJobStatus): boolean {
  const carried: DeliveryJobStatus[] = [
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.EN_ROUTE,
    DeliveryJobStatus.ARRIVED_DROPOFF,
    DeliveryJobStatus.DELIVERED,
    DeliveryJobStatus.COMPLETED,
  ];
  return carried.includes(status);
}

const uow: IUnitOfWork = { run: (work) => work({}) };

function fakeAudit() {
  const entries: { action: string; context: Record<string, unknown> | null }[] = [];
  const audit = {
    record: jest.fn(
      async (params: { action: string; context?: Record<string, unknown> | null }) => {
        entries.push({ action: params.action, context: params.context ?? null });
        return { id: 'audit-1', hash: 'h' };
      },
    ),
  } as unknown as AuditService;
  return { audit, entries };
}

function fakeOutbox() {
  const events: DomainEvent<Record<string, unknown>>[] = [];
  const outbox = {
    write: jest.fn(async (event: DomainEvent<Record<string, unknown>>) => {
      events.push(event);
    }),
  } as unknown as OutboxService;
  return { outbox, events };
}

function fakeIdentity(eligible = true): IIdentityPort {
  return {
    getDriverIdentity: jest.fn(async (userId: string) => ({
      userId,
      isEligible: eligible,
      reason: eligible ? null : ('DOCUMENTS_EXPIRED' as const),
      documentsExpireAt: null,
    })),
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  throw new Error('expected a throw');
}

/**
 * The proof-of-delivery repository, as this suite needs it.
 *
 * Left empty by default, which is the platform's default situation too: with
 * `delivery.podRequirement` at `NONE` the gate never reads it, so every existing status-workflow
 * assertion is testing the same path it always tested. The suite's own PoD tests populate it.
 */
class FakeProofRepository implements Partial<IProofOfDeliveryRepository> {
  proofs = new Map<string, ProofOfDeliveryProps>();
  reads = 0;

  async insert(proof: ProofOfDeliveryProps): Promise<ProofOfDeliveryProps | null> {
    if (this.proofs.has(proof.jobId)) {
      return null;
    }
    this.proofs.set(proof.jobId, proof);
    return proof;
  }

  async findByJobId(jobId: string): Promise<ProofOfDeliveryProps | null> {
    this.reads += 1;
    return this.proofs.get(jobId) ?? null;
  }
}

/** Config with nothing set — every PoD requirement falls back to its `NONE` default. */
class FakeConfig implements IConfigPort {
  values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  getOrThrow<T>(key: string): T {
    return this.values.get(key) as T;
  }
  isFeatureEnabled(): boolean {
    return false;
  }
}

/**
 * A minimal earnings ledger, enforcing the real unique key on `jobId`.
 *
 * Present in this suite because `COMPLETED` now requires an accrued earning (BR-DEL-10). `seed`
 * puts one there for the transitions that should succeed; leaving it empty is what the gate's own
 * test exercises.
 */
class FakeEarningRepository implements IDriverEarningRepository {
  readonly rows = new Map<string, DriverEarningProps>();

  seed(jobId: string): DriverEarningProps {
    const earning: DriverEarningProps = {
      id: `earning-${jobId}`,
      driverId: 'driver-profile-1',
      jobId,
      orderId: 'order-1',
      fulfillmentId: 'fulfillment-1',
      base: 0,
      distanceComponent: 0,
      feeShare: 0,
      incentive: 0,
      total: 0,
      currency: 'ETB',
      status: EarningStatus.ACCRUED,
      distanceMeters: null,
      calculationVersion: 'v1',
      createdAt: new Date(),
    };
    this.rows.set(jobId, earning);
    return earning;
  }

  async insert(earning: DriverEarningProps): Promise<DriverEarningProps | null> {
    if (this.rows.has(earning.jobId)) {
      return null;
    }
    this.rows.set(earning.jobId, earning);
    return earning;
  }

  async findByJobId(jobId: string): Promise<DriverEarningProps | null> {
    return this.rows.get(jobId) ?? null;
  }

  async listByDriver(): Promise<{ items: DriverEarningProps[]; total: number }> {
    return { items: [], total: 0 };
  }
}

/**
 * A minimal COD ledger, enforcing the real unique key on `jobId`.
 *
 * Present in these suites because `COMPLETED` can now be gated on a recorded collection
 * (BR-DEL-10). The gate is off by default, so an empty ledger is the right fixture for everything
 * that is not testing the gate itself.
 */
class FakeCodCollectionRepository implements ICodCollectionRepository {
  readonly rows = new Map<string, CodCollectionProps>();

  seed(jobId: string): CodCollectionProps {
    const collection: CodCollectionProps = {
      id: `cod-${jobId}`,
      jobId,
      orderId: 'order-1',
      fulfillmentId: 'fulfillment-1',
      driverId: 'driver-profile-1',
      expectedAmount: 24_500,
      collectedAmount: 24_500,
      currency: 'ETB',
      method: CodCollectionMethod.CASH,
      status: CodCollectionStatus.COLLECTED,
      providerReference: null,
      collectedAt: new Date(),
      recordedAt: new Date(),
      remittedAt: null,
      reconciledAt: null,
      settlementRef: null,
    };
    this.rows.set(jobId, collection);
    return collection;
  }

  async insert(collection: CodCollectionProps): Promise<CodCollectionProps | null> {
    if (this.rows.has(collection.jobId)) {
      return null;
    }
    this.rows.set(collection.jobId, collection);
    return collection;
  }

  async findByJobId(jobId: string): Promise<CodCollectionProps | null> {
    return this.rows.get(jobId) ?? null;
  }

  // ------------------------------------------------------------------------------------------
  // The remittance and reconciliation half of the contract.
  //
  // Unused in this suite and deliberately fatal rather than silently empty: these suites exercise
  // the *driver's* side of COD, and a stub that quietly returned `null` would let a future change
  // start depending on PharmaLink-side behaviour here without anybody noticing. The remittance
  // suite has a fake that actually implements them.
  // ------------------------------------------------------------------------------------------

  async findById(): Promise<CodCollectionProps | null> {
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

  async findRemittanceByCollectionId(): Promise<CodRemittanceProps | null> {
    throw new Error('not used in this suite');
  }

  async insertReconciliation(): Promise<CodReconciliationProps | null> {
    throw new Error('not used in this suite');
  }

  async findReconciliationByCollectionId(): Promise<CodReconciliationProps | null> {
    throw new Error('not used in this suite');
  }

  async findRecordById(): Promise<CodCollectionRecord | null> {
    throw new Error('not used in this suite');
  }

  async search(): Promise<CodCollectionPage> {
    throw new Error('not used in this suite');
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

  // Work 14's finance aggregate. Exercised against real SQL in
  // `test/delivery/cod-reporting.e2e-spec.ts`; the totals are computed by Postgres, so a hand-rolled
  // fake here would only test the fake.
  summarize(): Promise<never> {
    throw new Error('summarize is not used in these unit tests.');
  }
}

describe('Delivery status workflow', () => {
  let jobs: FakeJobRepository;
  let profiles: FakeProfileRepository;
  let proofs: FakeProofRepository;
  let earnings: FakeEarningRepository;
  let codCollections: FakeCodCollectionRepository;
  let config: FakeConfig;
  let entries: { action: string; context: Record<string, unknown> | null }[];
  let events: DomainEvent<Record<string, unknown>>[];
  let advance: AdvanceDeliveryJobCommand;

  function build(identity: IIdentityPort = fakeIdentity()) {
    jobs = new FakeJobRepository();
    profiles = new FakeProfileRepository();
    proofs = new FakeProofRepository();
    earnings = new FakeEarningRepository();
    codCollections = new FakeCodCollectionRepository();
    config = new FakeConfig();
    const audit = fakeAudit();
    const outbox = fakeOutbox();
    entries = audit.entries;
    events = outbox.events;
    advance = new AdvanceDeliveryJobCommand(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      identity,
      uow,
      proofs as unknown as IProofOfDeliveryRepository,
      earnings,
      codCollections,
      config,
      audit.audit,
      outbox.outbox,
    );
    return advance;
  }

  beforeEach(() => {
    build();
  });

  function drive(to: DeliveryJobStatus, reason?: string) {
    return advance.byDriver({ userId: DRIVER_USER, jobId: 'job-1', to, reason });
  }

  // -------------------------------------------------------------------------------------------
  // 1. The happy path, transition by transition
  // -------------------------------------------------------------------------------------------
  describe('the lifecycle', () => {
    it.each([
      [DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.ARRIVED_PICKUP],
      [DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP],
      [DeliveryJobStatus.PICKED_UP, DeliveryJobStatus.EN_ROUTE],
      [DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.ARRIVED_DROPOFF],
      [DeliveryJobStatus.ARRIVED_DROPOFF, DeliveryJobStatus.DELIVERED],
    ])('moves %s → %s', async (from, to) => {
      jobs.seed(job(from));
      const result = await drive(to);

      expect(result.changed).toBe(true);
      expect(result.job.status).toBe(to);
      expect(jobs.jobs.get('job-1')!.status).toBe(to);
    });

    it('completes a delivered job as the platform, not the driver', async () => {
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));

      earnings.seed('job-1');
      const result = await advance.bySystem({
        jobId: 'job-1',
        to: DeliveryJobStatus.COMPLETED,
      });

      expect(result.job.status).toBe(DeliveryJobStatus.COMPLETED);
      expect(entries[0].context).toMatchObject({ from: 'DELIVERED', to: 'COMPLETED' });
    });

    /**
     * BR-DEL-10's gate. `COMPLETED` is the platform closing its books on a delivery, and the
     * earnings ledger is half of what "closed" means — so the transition is refused until the
     * driver's earning exists, and the job stays exactly where it was.
     */
    it('refuses to complete a delivery whose driver earning has not been accrued', async () => {
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));

      expect(
        await codeOf(() => advance.bySystem({ jobId: 'job-1', to: DeliveryJobStatus.COMPLETED })),
      ).toBe(ErrorCode.CONFLICT);
      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.DELIVERED);
    });

    it('writes nothing at all when the earning gate refuses', async () => {
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));

      await codeOf(() => advance.bySystem({ jobId: 'job-1', to: DeliveryJobStatus.COMPLETED }));

      // A physically delivered order must not be retracted, downgraded or annotated because the
      // platform could not finish its bookkeeping.
      expect(jobs.history).toHaveLength(0);
      expect(entries).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('completes once the earning is there, with nothing else changed', async () => {
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));
      await codeOf(() => advance.bySystem({ jobId: 'job-1', to: DeliveryJobStatus.COMPLETED }));

      earnings.seed('job-1');
      const result = await advance.bySystem({
        jobId: 'job-1',
        to: DeliveryJobStatus.COMPLETED,
      });

      expect(result.changed).toBe(true);
      expect(result.job.status).toBe(DeliveryJobStatus.COMPLETED);
    });

    it('applies the earning gate only to COMPLETED', async () => {
      // Every other transition runs with an empty ledger, which is the ordinary case: an earning
      // does not exist until the delivery has happened.
      jobs.seed(job(DeliveryJobStatus.ARRIVED_DROPOFF));

      const result = await drive(DeliveryJobStatus.DELIVERED);

      expect(result.changed).toBe(true);
      expect(earnings.rows.size).toBe(0);
    });

    it('refuses a driver who tries to complete their own job', async () => {
      // DELIVERED is the driver's assertion; COMPLETED is the platform closing the books.
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));
      expect(await codeOf(() => drive(DeliveryJobStatus.COMPLETED))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('runs the whole lifecycle end to end', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      for (const to of [
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
        DeliveryJobStatus.DELIVERED,
      ]) {
        earnings.seed('job-1');
        await drive(to);
      }
      await advance.bySystem({ jobId: 'job-1', to: DeliveryJobStatus.COMPLETED });

      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.COMPLETED);
      expect(jobs.history.map((h) => h.toStatus)).toEqual([
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
        DeliveryJobStatus.DELIVERED,
        DeliveryJobStatus.COMPLETED,
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. Invalid transitions
  // -------------------------------------------------------------------------------------------
  describe('invalid transitions', () => {
    it('refuses a backward move', async () => {
      jobs.seed(job(DeliveryJobStatus.EN_ROUTE));
      expect(await codeOf(() => drive(DeliveryJobStatus.PICKED_UP))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.EN_ROUTE);
    });

    it('refuses a skipped step', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      expect(await codeOf(() => drive(DeliveryJobStatus.DELIVERED))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });

    it('refuses any move out of a terminal state', async () => {
      jobs.seed(job(DeliveryJobStatus.COMPLETED, { deliveredAt: new Date() }));
      expect(await codeOf(() => drive(DeliveryJobStatus.DELIVERED))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });

    it('writes nothing when a transition is refused', async () => {
      jobs.seed(job(DeliveryJobStatus.EN_ROUTE));
      await codeOf(() => drive(DeliveryJobStatus.PICKED_UP));

      expect(jobs.history).toHaveLength(0);
      expect(entries).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. Ownership
  // -------------------------------------------------------------------------------------------
  describe('driver ownership', () => {
    it('refuses a driver who is not the one carrying the job', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED, { assignedDriverId: OTHER_PROFILE }));
      // NOT_FOUND, not FORBIDDEN — job ids must not be probeable for who is carrying what.
      expect(await codeOf(() => drive(DeliveryJobStatus.ARRIVED_PICKUP))).toBe(
        ErrorCode.NOT_FOUND,
      );
      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.ASSIGNED);
    });

    it('refuses a driver released by a reassignment mid-request', async () => {
      // The in-transaction re-check. The read passes; the reassignment commits; the write must
      // not proceed against a job the driver no longer holds.
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      jobs.onUpdate = async () => {
        jobs.jobs.set('job-1', {
          ...jobs.jobs.get('job-1')!,
          assignedDriverId: OTHER_PROFILE,
        });
      };

      expect(await codeOf(() => drive(DeliveryJobStatus.ARRIVED_PICKUP))).toBe(
        ErrorCode.NOT_FOUND,
      );
    });

    it('refuses a user with no driver profile', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      profiles.profile = null;
      expect(await codeOf(() => drive(DeliveryJobStatus.ARRIVED_PICKUP))).toBe(
        ErrorCode.NOT_FOUND,
      );
    });

    it('never accepts a caller-supplied driver id', () => {
      // Structural: the input type has no driver field at all, so there is nothing to trust.
      const input: Parameters<AdvanceDeliveryJobCommand['byDriver']>[0] = {
        userId: DRIVER_USER,
        jobId: 'job-1',
        to: DeliveryJobStatus.ARRIVED_PICKUP,
      };
      expect(Object.keys(input)).not.toContain('driverId');
      expect(Object.keys(input)).not.toContain('assignedDriverId');
    });

    it('refuses a driver whose verification was revoked mid-delivery', async () => {
      build(fakeIdentity(false));
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      expect(await codeOf(() => drive(DeliveryJobStatus.ARRIVED_PICKUP))).toBe(
        ErrorCode.DRIVER_NOT_VERIFIED,
      );
    });

    it('does not check ownership for a platform transition', async () => {
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));
      earnings.seed('job-1');
      const result = await advance.bySystem({
        jobId: 'job-1',
        to: DeliveryJobStatus.COMPLETED,
      });
      expect(result.changed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. Idempotency
  // -------------------------------------------------------------------------------------------
  describe('idempotency', () => {
    it('treats a repeat of the current status as a successful no-op', async () => {
      jobs.seed(job(DeliveryJobStatus.PICKED_UP));
      const result = await drive(DeliveryJobStatus.PICKED_UP);

      expect(result.changed).toBe(false);
      expect(result.job.status).toBe(DeliveryJobStatus.PICKED_UP);
    });

    it('writes no history, no audit entry and no event on a repeat', async () => {
      // The half that matters: a duplicate /picked-up that re-emitted OrderPickedUp would
      // advance Module 06's order twice.
      jobs.seed(job(DeliveryJobStatus.ARRIVED_PICKUP));
      await drive(DeliveryJobStatus.PICKED_UP);
      const after = { history: jobs.history.length, audit: entries.length, events: events.length };

      await drive(DeliveryJobStatus.PICKED_UP);
      await drive(DeliveryJobStatus.PICKED_UP);

      expect(jobs.history).toHaveLength(after.history);
      expect(entries).toHaveLength(after.audit);
      expect(events).toHaveLength(after.events);
    });

    it('does not restamp a physical timestamp on a repeat', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_PICKUP));
      const first = await drive(DeliveryJobStatus.PICKED_UP);
      const stamped = first.job.pickedUpAt;

      const again = await drive(DeliveryJobStatus.PICKED_UP);
      expect(again.job.pickedUpAt).toEqual(stamped);
    });

    it('distinguishes a retry from a stale request that has been overtaken', async () => {
      jobs.seed(job(DeliveryJobStatus.EN_ROUTE));
      // Same status → retry. Earlier status → refused.
      expect((await drive(DeliveryJobStatus.EN_ROUTE)).changed).toBe(false);
      expect(await codeOf(() => drive(DeliveryJobStatus.PICKED_UP))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. Concurrency
  // -------------------------------------------------------------------------------------------
  describe('compare-and-set', () => {
    it('lets only one of two racing identical requests write', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_PICKUP));
      // The competitor commits between this request's read and its write.
      jobs.onUpdate = async () => {
        jobs.jobs.set('job-1', {
          ...jobs.jobs.get('job-1')!,
          status: DeliveryJobStatus.PICKED_UP,
          pickedUpAt: HOURS_AGO(1),
        });
      };

      const result = await drive(DeliveryJobStatus.PICKED_UP);

      // The loser discovers the job already holds what it wanted — a duplicate, not a conflict.
      expect(result.changed).toBe(false);
      expect(result.job.status).toBe(DeliveryJobStatus.PICKED_UP);
      // And it wrote nothing of its own.
      expect(jobs.history).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('refuses a request whose target the winner overshot', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_PICKUP));
      jobs.onUpdate = async () => {
        jobs.jobs.set('job-1', {
          ...jobs.jobs.get('job-1')!,
          status: DeliveryJobStatus.EN_ROUTE,
          pickedUpAt: HOURS_AGO(1),
        });
      };

      expect(await codeOf(() => drive(DeliveryJobStatus.PICKED_UP))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.EN_ROUTE);
    });

    it('never applies a stale write over a newer state', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_PICKUP));
      jobs.onUpdate = async () => {
        jobs.jobs.set('job-1', {
          ...jobs.jobs.get('job-1')!,
          status: DeliveryJobStatus.DELIVERED,
          pickedUpAt: HOURS_AGO(1),
          deliveredAt: HOURS_AGO(0.5),
        });
      };

      await codeOf(() => drive(DeliveryJobStatus.PICKED_UP));
      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.DELIVERED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 6. Physical timestamps
  // -------------------------------------------------------------------------------------------
  describe('timestamps', () => {
    it('stamps pickedUpAt on the transition that causes it, and nothing earlier', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      const arrived = await drive(DeliveryJobStatus.ARRIVED_PICKUP);
      expect(arrived.job.pickedUpAt).toBeNull();

      const picked = await drive(DeliveryJobStatus.PICKED_UP);
      expect(picked.job.pickedUpAt).toBeInstanceOf(Date);
    });

    it('stamps deliveredAt only at DELIVERED', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_DROPOFF));
      expect(jobs.jobs.get('job-1')!.deliveredAt).toBeNull();

      const delivered = await drive(DeliveryJobStatus.DELIVERED);
      expect(delivered.job.deliveredAt).toBeInstanceOf(Date);
    });

    it('records deliveredAt at or after pickedUpAt', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_DROPOFF));
      const delivered = await drive(DeliveryJobStatus.DELIVERED);
      expect(delivered.job.deliveredAt!.getTime()).toBeGreaterThanOrEqual(
        delivered.job.pickedUpAt!.getTime(),
      );
    });

    it('refuses to persist a delivery that precedes its own pickup', async () => {
      // The aggregate's invariant, reached through the command: a row whose chronology is
      // impossible is a clock or a code defect, not a delivery.
      const impossible = job(DeliveryJobStatus.ARRIVED_DROPOFF, {
        pickedUpAt: new Date('2030-01-01T00:00:00.000Z'),
      });
      jobs.seed(impossible);
      expect(await codeOf(() => drive(DeliveryJobStatus.DELIVERED))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
      expect(jobs.jobs.get('job-1')!.status).toBe(DeliveryJobStatus.ARRIVED_DROPOFF);
    });

    it('refuses to load a job that claims delivery without pickup', async () => {
      jobs.seed(
        job(DeliveryJobStatus.ARRIVED_DROPOFF, {
          pickedUpAt: null,
          deliveredAt: HOURS_AGO(1),
        }),
      );
      expect(await codeOf(() => drive(DeliveryJobStatus.DELIVERED))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 7. Events
  // -------------------------------------------------------------------------------------------
  describe('events', () => {
    it('emits OrderPickedUp exactly once', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_PICKUP));
      await drive(DeliveryJobStatus.PICKED_UP);
      await drive(DeliveryJobStatus.PICKED_UP);

      const emitted = events.filter((e) => e.type === DeliveryEventType.OrderPickedUp);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].payload).toMatchObject({
        jobId: 'job-1',
        orderId: ORDER,
        fulfillmentId: 'fulfillment-1',
        driverId: DRIVER_PROFILE,
        status: DeliveryJobStatus.PICKED_UP,
      });
    });

    it('emits EnRoute and OrderDelivered on their own transitions', async () => {
      jobs.seed(job(DeliveryJobStatus.PICKED_UP));
      await drive(DeliveryJobStatus.EN_ROUTE);
      await drive(DeliveryJobStatus.ARRIVED_DROPOFF);
      await drive(DeliveryJobStatus.DELIVERED);

      expect(events.map((e) => e.type)).toEqual([
        DeliveryEventType.EnRoute,
        DeliveryEventType.OrderDelivered,
      ]);
    });

    it('stays silent on the two arrival steps and on completion', async () => {
      // No catalogued consumer for any of them; they are recorded in history instead.
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      earnings.seed('job-1');
      await drive(DeliveryJobStatus.ARRIVED_PICKUP);
      expect(events).toHaveLength(0);

      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));
      await advance.bySystem({ jobId: 'job-1', to: DeliveryJobStatus.COMPLETED });
      expect(events.filter((e) => e.type.includes('completed'))).toHaveLength(0);
    });

    it('carries the reason on DeliveryFailed', async () => {
      jobs.seed(job(DeliveryJobStatus.EN_ROUTE));
      await drive(DeliveryJobStatus.FAILED, 'Recipient absent');

      const failed = events.find((e) => e.type === DeliveryEventType.DeliveryFailed);
      expect(failed!.payload).toMatchObject({ reason: 'Recipient absent', jobId: 'job-1' });
    });

    it('publishes no location and no proof of delivery', async () => {
      jobs.seed(job(DeliveryJobStatus.ARRIVED_DROPOFF));
      await advance.byDriver({
        userId: DRIVER_USER,
        jobId: 'job-1',
        to: DeliveryJobStatus.DELIVERED,
        lat: 9.03,
        lng: 38.74,
      });

      const payload = JSON.stringify(events[0].payload);
      expect(payload).not.toContain('lat');
      expect(payload).not.toContain('podRef');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 8. Failed delivery
  // -------------------------------------------------------------------------------------------
  describe('failed delivery', () => {
    it.each([
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ])('fails from %s', async (from) => {
      jobs.seed(job(from));
      const result = await drive(DeliveryJobStatus.FAILED, 'Recipient absent');
      expect(result.job.status).toBe(DeliveryJobStatus.FAILED);
    });

    it('refuses to fail a job the driver has not picked up', async () => {
      // Nothing in the design describes a job failing while the goods are on the shelf; that is
      // a cancellation or a reassignment.
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      expect(await codeOf(() => drive(DeliveryJobStatus.FAILED, 'Nope'))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    });

    it('requires a reason', async () => {
      jobs.seed(job(DeliveryJobStatus.EN_ROUTE));
      expect(await codeOf(() => drive(DeliveryJobStatus.FAILED))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
      expect(await codeOf(() => drive(DeliveryJobStatus.FAILED, '   '))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('keeps the driver attached, so the trail says who was carrying it', async () => {
      jobs.seed(job(DeliveryJobStatus.EN_ROUTE));
      const result = await drive(DeliveryJobStatus.FAILED, 'Recipient absent');
      expect(result.job.assignedDriverId).toBe(DRIVER_PROFILE);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 9. Cancellation and the pickup boundary
  // -------------------------------------------------------------------------------------------
  describe('cancellation', () => {
    let cancel: CancelDeliveryJobCommand;

    beforeEach(() => {
      cancel = new CancelDeliveryJobCommand(
        jobs as unknown as IDeliveryJobRepository,
        advance,
      );
    });

    it.each([
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.ARRIVED_PICKUP,
    ])('cancels a job in %s', async (status) => {
      jobs.seed(job(status));
      const result = await cancel.execute({ jobId: 'job-1', reason: 'Order cancelled' });
      expect(result.status).toBe(DeliveryJobStatus.CANCELLED);
    });

    it.each([
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
    ])('refuses to cancel a job in %s', async (status) => {
      // Once a driver holds the medicines, "cancelled" contradicts the world: the items are in a
      // bag and have to end up somewhere. That path is FAILED, which carries a return obligation.
      jobs.seed(job(status, { deliveredAt: null }));
      expect(
        await codeOf(() => cancel.execute({ jobId: 'job-1', reason: 'Too late' })),
      ).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
    });

    it('cancels every job of a split order and reports the ones it cannot', async () => {
      jobs.seed({ ...job(DeliveryJobStatus.ASSIGNED), id: 'job-a' });
      jobs.seed({ ...job(DeliveryJobStatus.PICKED_UP), id: 'job-b' });

      const result = await cancel.forOrder({ orderId: ORDER, reason: 'Customer cancelled' });

      // One driver already collecting must not stop the other job from being cancelled.
      expect(result.cancelled.map((j) => j.id)).toEqual(['job-a']);
      expect(result.refused).toEqual([
        { jobId: 'job-b', status: DeliveryJobStatus.PICKED_UP },
      ]);
    });

    it('is idempotent for an already cancelled job', async () => {
      jobs.seed({ ...job(DeliveryJobStatus.CANCELLED), id: 'job-a' });
      const result = await cancel.forOrder({ orderId: ORDER, reason: 'Again' });

      expect(result.unchanged.map((j) => j.id)).toEqual(['job-a']);
      expect(result.cancelled).toHaveLength(0);
      expect(jobs.history).toHaveLength(0);
    });

    it('requires a reason', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      expect(await codeOf(() => cancel.execute({ jobId: 'job-1', reason: '  ' }))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // 10. History and the derived timeline
  // -------------------------------------------------------------------------------------------
  describe('history', () => {
    it('records each transition once, in order, with its actor', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      await drive(DeliveryJobStatus.ARRIVED_PICKUP);
      await drive(DeliveryJobStatus.ARRIVED_PICKUP); // retry
      earnings.seed('job-1');
      await drive(DeliveryJobStatus.PICKED_UP);

      expect(jobs.history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual([
        'ASSIGNED->ARRIVED_PICKUP',
        'ARRIVED_PICKUP->PICKED_UP',
      ]);
      expect(jobs.history[0].actorType).toBe(DeliveryActorType.DRIVER);
      expect(jobs.history[0].actorId).toBe(DRIVER_PROFILE);
    });

    it('records a platform transition as SYSTEM', async () => {
      jobs.seed(job(DeliveryJobStatus.DELIVERED, { deliveredAt: new Date() }));
      earnings.seed('job-1');
      await advance.bySystem({ jobId: 'job-1', to: DeliveryJobStatus.COMPLETED });

      expect(jobs.history[0].actorType).toBe(DeliveryActorType.SYSTEM);
      expect(jobs.history[0].actorId).toBeNull();
    });

    it('records the driver position supplied with the post', async () => {
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      await advance.byDriver({
        userId: DRIVER_USER,
        jobId: 'job-1',
        to: DeliveryJobStatus.ARRIVED_PICKUP,
        lat: 9.03,
        lng: 38.74,
      });

      expect(jobs.history[0]).toMatchObject({ lat: 9.03, lng: 38.74 });
    });

    it('derives the intermediate timestamps from the history', async () => {
      const query = new GetDeliveryJobStatusQuery(jobs as unknown as IDeliveryJobRepository);
      jobs.seed(job(DeliveryJobStatus.ASSIGNED));
      for (const to of [
        DeliveryJobStatus.ARRIVED_PICKUP,
        DeliveryJobStatus.PICKED_UP,
        DeliveryJobStatus.EN_ROUTE,
        DeliveryJobStatus.ARRIVED_DROPOFF,
        DeliveryJobStatus.DELIVERED,
      ]) {
        await drive(to);
      }

      const view = await query.execute({ jobId: 'job-1' });
      expect(view.timeline.arrivedPickupAt).toBeInstanceOf(Date);
      expect(view.timeline.enRouteAt).toBeInstanceOf(Date);
      expect(view.timeline.arrivedDropoffAt).toBeInstanceOf(Date);
      expect(view.timeline.completedAt).toBeNull();
      // The two that are columns come from the job itself, not from history.
      expect(view.timeline.pickedUpAt).toEqual(jobs.jobs.get('job-1')!.pickedUpAt);
      expect(view.timeline.deliveredAt).toEqual(jobs.jobs.get('job-1')!.deliveredAt);
      expect(view.history).toHaveLength(5);
    });

    it('scopes the status read to the job’s current driver', async () => {
      const query = new GetDeliveryJobStatusQuery(jobs as unknown as IDeliveryJobRepository);
      jobs.seed(job(DeliveryJobStatus.ASSIGNED, { assignedDriverId: OTHER_PROFILE }));

      expect(
        await codeOf(() => query.execute({ jobId: 'job-1', requireDriverId: DRIVER_PROFILE })),
      ).toBe(ErrorCode.NOT_FOUND);
    });
  });
});
