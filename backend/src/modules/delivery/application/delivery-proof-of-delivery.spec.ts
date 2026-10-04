import { createHash } from 'crypto';
import { AuditService } from '../../../shared/audit/audit.service';
import { IConfigPort } from '../../../shared/config/config.port';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DomainEvent } from '../../../shared/events/domain-event';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { DeliveryJob, DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import { ProofOfDelivery, ProofOfDeliveryProps } from '../domain/entities/proof-of-delivery.entity';
import { DeliveryJobStatus, DriverAvailability, PodType } from '../domain/enums';
import { DeliveryEventType } from '../domain/events';
import {
  DeliveryJobStateExpectation,
  DeliveryStatusHistoryEntry,
  DeliveryStatusHistoryRecord,
  IDeliveryJobRepository,
} from '../domain/repositories/delivery-job.repository';
import { IDriverProfileRepository } from '../domain/repositories/driver-profile.repository';
import { IProofOfDeliveryRepository } from '../domain/repositories/proof-of-delivery.repository';
import {
  PodPolicySettings,
  PodRequirement,
  ProofOfDeliveryPolicy,
} from '../domain/services/proof-of-delivery-policy';
import { AdvanceDeliveryJobCommand } from './commands/advance-delivery-job.command';
import { CaptureProofOfDeliveryCommand } from './commands/capture-proof-of-delivery.command';
import { IIdentityPort } from './ports/outbound/identity.port';
import { IOrdersPort } from './ports/outbound/orders.port';
import {
  IProofArtifactStoragePort,
  ProofArtifactUpload,
  StoredProofArtifact,
} from './ports/outbound/proof-artifact-storage.port';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { GetProofOfDeliveryQuery } from './queries/get-proof-of-delivery.query';
import { DeliveryAccessService, DeliveryViewer } from './services/delivery-access.service';
import {
  POD_COD_REQUIREMENT_CONFIG_KEY,
  POD_COLD_CHAIN_REQUIREMENT_CONFIG_KEY,
  POD_REQUIREMENT_CONFIG_KEY,
} from './services/pod-requirement';
import { DriverEarningProps } from '../domain/entities/driver-earning.entity';
import { IDriverEarningRepository } from '../domain/repositories/driver-earning.repository';

const JOB_ID = 'job-pod-1';
const ORDER_ID = 'order-pod-1';
const FULFILLMENT_ID = 'fulfillment-pod-1';
const DRIVER_USER = 'user-driver-1';
const DRIVER_PROFILE = 'driver-profile-1';
const OTHER_USER = 'user-driver-2';
const OTHER_PROFILE = 'driver-profile-2';
const CUSTOMER_USER = 'user-customer-1';
const STRANGER_USER = 'user-stranger-1';

/** A one-pixel PNG. Small, deterministic, and a real image rather than random bytes. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_SHA256 = createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex');
/** A *different* one-pixel image, so "same evidence" and "different evidence" are distinguishable. */
const OTHER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
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

const HOURS_AGO = (n: number): Date => new Date(Date.now() - n * 3_600_000);

// -----------------------------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------------------------

class FakeJobRepository implements Partial<IDeliveryJobRepository> {
  readonly jobs = new Map<string, DeliveryJobProps>();
  readonly history: DeliveryStatusHistoryRecord[] = [];
  private seq = 0;

  seed(job: DeliveryJobProps): void {
    this.jobs.set(job.id, { ...job });
  }

  async findById(id: string): Promise<DeliveryJobProps | null> {
    const job = this.jobs.get(id);
    return job ? { ...job } : null;
  }

  async updateState(
    id: string,
    expected: DeliveryJobStateExpectation,
    update: { status: DeliveryJobStatus; pickedUpAt?: Date | null; deliveredAt?: Date | null },
  ): Promise<DeliveryJobProps | null> {
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
      createdAt: new Date(Date.now() + this.seq),
    });
  }
}

class FakeProfileRepository implements Partial<IDriverProfileRepository> {
  readonly profiles = new Map<string, DriverProfileProps>();

  async findByUserId(userId: string): Promise<DriverProfileProps | null> {
    const found = [...this.profiles.values()].find((p) => p.userId === userId);
    return found ? { ...found } : null;
  }

  async findById(id: string): Promise<DriverProfileProps | null> {
    const found = this.profiles.get(id);
    return found ? { ...found } : null;
  }
}

/**
 * The proof repository, with a **real** uniqueness check on `jobId`.
 *
 * `insert` returns `null` on a collision exactly as the Prisma adapter does when Postgres raises
 * `P2002`, so the idempotency tests below exercise the branch that actually runs in production
 * rather than one a permissive fake invented.
 */
class FakeProofRepository implements Partial<IProofOfDeliveryRepository> {
  readonly proofs = new Map<string, ProofOfDeliveryProps>();
  reads = 0;
  inserts = 0;

  async insert(proof: ProofOfDeliveryProps): Promise<ProofOfDeliveryProps | null> {
    if (this.proofs.has(proof.jobId)) {
      return null;
    }
    this.inserts += 1;
    this.proofs.set(proof.jobId, { ...proof });
    return { ...proof };
  }

  async findByJobId(jobId: string): Promise<ProofOfDeliveryProps | null> {
    this.reads += 1;
    const found = this.proofs.get(jobId);
    return found ? { ...found } : null;
  }
}

/** Content-addressed, like the real in-memory adapter and like any sane object store. */
class FakeStorage implements IProofArtifactStoragePort {
  readonly stored = new Map<string, StoredProofArtifact>();
  storeCalls = 0;
  /** Set to make `describe` behave as if the object has gone missing. */
  describeReturnsNull = false;
  /** Set to make `describe` throw, as an unreachable provider would. */
  describeThrows = false;

  async store(upload: ProofArtifactUpload): Promise<StoredProofArtifact> {
    this.storeCalls += 1;
    const sha256 = createHash('sha256').update(upload.content).digest('hex');
    const descriptor: StoredProofArtifact = {
      ref: `pod/${upload.jobId}/${sha256}`,
      contentType: upload.contentType,
      bytes: upload.content.length,
      sha256,
    };
    this.stored.set(descriptor.ref, descriptor);
    return descriptor;
  }

  async describe(ref: string): Promise<Omit<StoredProofArtifact, 'ref'> | null> {
    if (this.describeThrows) {
      throw new Error('storage unreachable');
    }
    if (this.describeReturnsNull) {
      return null;
    }
    const found = this.stored.get(ref);
    return found
      ? { contentType: found.contentType, bytes: found.bytes, sha256: found.sha256 }
      : null;
  }
}

class FakeOrdersPort implements Partial<IOrdersPort> {
  readonly owners = new Map<string, string>();

  async getOrderCustomerUserId(orderId: string): Promise<string | null> {
    return this.owners.get(orderId) ?? null;
  }
}

class FakeConfig implements IConfigPort {
  readonly values = new Map<string, unknown>();
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

const identity: IIdentityPort = {
  getDriverIdentity: jest.fn(async (userId: string) => ({
    userId,
    isEligible: true,
    reason: null,
    documentsExpireAt: null,
  })),
};

function profile(overrides: Partial<DriverProfileProps> = {}): DriverProfileProps {
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
    ...overrides,
  };
}

function job(overrides: Partial<DeliveryJobProps> = {}): DeliveryJobProps {
  const base = DeliveryJob.create({
    id: JOB_ID,
    orderId: ORDER_ID,
    fulfillmentId: FULFILLMENT_ID,
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
  }).toProps();
  return {
    ...base,
    status: DeliveryJobStatus.ARRIVED_DROPOFF,
    assignedDriverId: DRIVER_PROFILE,
    pickedUpAt: HOURS_AGO(1),
    ...overrides,
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
 * A minimal earnings ledger, enforcing the real unique key on `jobId`.
 *
 * Present in this suite because `COMPLETED` now requires an accrued earning (BR-DEL-10), and this
 * suite drives `AdvanceDeliveryJobCommand`. Nothing here reaches `COMPLETED`, so an empty ledger
 * is the right fixture; the gate's own behaviour is exercised where it belongs.
 */
class FakeEarningRepository implements IDriverEarningRepository {
  readonly rows = new Map<string, DriverEarningProps>();

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

describe('Proof of delivery', () => {
  let jobs: FakeJobRepository;
  let profiles: FakeProfileRepository;
  let proofs: FakeProofRepository;
  let storage: FakeStorage;
  let orders: FakeOrdersPort;
  let config: FakeConfig;
  let entries: { action: string; context: Record<string, unknown> | null }[];
  let events: DomainEvent<Record<string, unknown>>[];
  let capture: CaptureProofOfDeliveryCommand;
  let advance: AdvanceDeliveryJobCommand;
  let read: GetProofOfDeliveryQuery;

  beforeEach(() => {
    jobs = new FakeJobRepository();
    profiles = new FakeProfileRepository();
    proofs = new FakeProofRepository();
    storage = new FakeStorage();
    orders = new FakeOrdersPort();
    config = new FakeConfig();

    jobs.seed(job());
    profiles.profiles.set(DRIVER_PROFILE, profile());
    profiles.profiles.set(
      OTHER_PROFILE,
      profile({ id: OTHER_PROFILE, userId: OTHER_USER }),
    );
    orders.owners.set(ORDER_ID, CUSTOMER_USER);

    const auditing = fakeAudit();
    const outboxing = fakeOutbox();
    entries = auditing.entries;
    events = outboxing.events;

    capture = new CaptureProofOfDeliveryCommand(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      proofs as unknown as IProofOfDeliveryRepository,
      storage,
      uow,
      config,
      auditing.audit,
    );

    advance = new AdvanceDeliveryJobCommand(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      identity,
      uow,
      proofs as unknown as IProofOfDeliveryRepository,
      new FakeEarningRepository(),
      new FakeCodCollectionRepository(),
      config,
      auditing.audit,
      outboxing.outbox,
    );

    read = new GetProofOfDeliveryQuery(
      jobs as unknown as IDeliveryJobRepository,
      proofs as unknown as IProofOfDeliveryRepository,
      storage,
      new DeliveryAccessService(
        profiles as unknown as IDriverProfileRepository,
        orders as unknown as IOrdersPort,
      ),
    );
  });

  const submit = (overrides: Record<string, unknown> = {}) =>
    capture.execute({
      userId: DRIVER_USER,
      jobId: JOB_ID,
      type: PodType.CONFIRMATION,
      recipientName: 'Almaz Bekele',
      recipientConfirmed: true,
      ...overrides,
    });

  const photo = (base64 = PNG_BASE64) => ({
    type: PodType.PHOTO,
    artifact: { contentType: 'image/png', contentBase64: base64 },
  });

  const deliver = () =>
    advance.byDriver({
      userId: DRIVER_USER,
      jobId: JOB_ID,
      to: DeliveryJobStatus.DELIVERED,
    });

  // ---------------------------------------------------------------------------------------------
  // 1-4. The policy: what a delivery requires, and what satisfies it
  // ---------------------------------------------------------------------------------------------

  describe('ProofOfDeliveryPolicy', () => {
    const settings = (over: Partial<PodPolicySettings> = {}): PodPolicySettings => ({
      base: PodRequirement.None,
      coldChain: PodRequirement.None,
      cod: PodRequirement.None,
      ...over,
    });

    it('1. requires nothing by default, which is the platform position while the policy is open', () => {
      expect(
        ProofOfDeliveryPolicy.requirementFor({ isColdChain: true, isCod: true }, settings()),
      ).toBe(PodRequirement.None);
    });

    it('2. takes the strictest applicable rule rather than the first that matches', () => {
      const resolved = ProofOfDeliveryPolicy.requirementFor(
        { isColdChain: true, isCod: true },
        settings({ base: PodRequirement.Confirmation, cod: PodRequirement.Artifact }),
      );
      expect(resolved).toBe(PodRequirement.Artifact);
    });

    it('3. ignores a rule whose condition the delivery does not meet', () => {
      const resolved = ProofOfDeliveryPolicy.requirementFor(
        { isColdChain: false, isCod: false },
        settings({ base: PodRequirement.Confirmation, coldChain: PodRequirement.Artifact }),
      );
      expect(resolved).toBe(PodRequirement.Confirmation);
    });

    it('4. accepts stronger evidence than was demanded, and refuses weaker', () => {
      const confirmation = {
        type: PodType.CONFIRMATION,
        recipientConfirmed: true,
        artifactRef: null,
      };
      const signature = {
        type: PodType.SIGNATURE,
        recipientConfirmed: true,
        artifactRef: 'pod/x/y',
      };

      expect(ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.None, null)).toBe(true);
      expect(ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.Confirmation, null)).toBe(false);
      expect(ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.Confirmation, confirmation)).toBe(
        true,
      );
      expect(ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.Confirmation, signature)).toBe(
        true,
      );
      expect(ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.Artifact, confirmation)).toBe(
        false,
      );
      expect(ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.Artifact, signature)).toBe(true);
    });

    it('5. does not treat an unconfirmed confirmation as evidence of receipt', () => {
      expect(
        ProofOfDeliveryPolicy.isSatisfiedBy(PodRequirement.Confirmation, {
          type: PodType.CONFIRMATION,
          recipientConfirmed: false,
          artifactRef: null,
        }),
      ).toBe(false);
    });

    it('6. allows capture at the door and nowhere else', () => {
      const allowed = Object.values(DeliveryJobStatus).filter((status) =>
        ProofOfDeliveryPolicy.isCaptureAllowedIn(status),
      );
      expect(allowed).toEqual([DeliveryJobStatus.ARRIVED_DROPOFF]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 7-9. The aggregate's own coherence rules
  // ---------------------------------------------------------------------------------------------

  describe('ProofOfDelivery aggregate', () => {
    const base = {
      id: 'proof-x',
      jobId: JOB_ID,
      orderId: ORDER_ID,
      fulfillmentId: FULFILLMENT_ID,
      recipientConfirmed: true,
      capturedByDriverId: DRIVER_PROFILE,
    };

    it('7. refuses a photo proof that carries no photo', () => {
      expect(() => ProofOfDelivery.capture({ ...base, type: PodType.PHOTO })).toThrow(
        ApiException,
      );
    });

    it('8. refuses a confirmation that carries a file, because the type must stay trustworthy', () => {
      expect(() =>
        ProofOfDelivery.capture({
          ...base,
          type: PodType.CONFIRMATION,
          artifact: { ref: 'pod/a/b', contentType: 'image/png', bytes: 10, sha256: 'abc' },
        }),
      ).toThrow(ApiException);
    });

    it('9. exposes no way to change an accepted proof', () => {
      const proof = ProofOfDelivery.capture({ ...base, type: PodType.CONFIRMATION });
      const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(proof)).filter((name) =>
        /^(set|update|amend|attach|replace|supersede)/.test(name),
      );
      expect(mutators).toEqual([]);
      // And the snapshot is a copy, so a caller cannot reach the aggregate's state through it.
      const snapshot = proof.toProps();
      snapshot.recipientConfirmed = false;
      expect(proof.recipientConfirmed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 10-13. Capture: who, and when
  // ---------------------------------------------------------------------------------------------

  describe('capture authorization and timing', () => {
    it('10. lets the assigned driver capture proof at the door', async () => {
      const result = await submit();

      expect(result.created).toBe(true);
      expect(result.proof.jobId).toBe(JOB_ID);
      expect(result.proof.capturedByDriverId).toBe(DRIVER_PROFILE);
      // From the job, never from the request — the caller names neither.
      expect(result.proof.orderId).toBe(ORDER_ID);
      expect(result.proof.fulfillmentId).toBe(FULFILLMENT_ID);
    });

    it('11. answers NOT_FOUND when a different driver submits proof for the job', async () => {
      expect(await codeOf(() => submit({ userId: OTHER_USER }))).toBe(ErrorCode.NOT_FOUND);
      expect(proofs.proofs.size).toBe(0);
    });

    it('12. answers NOT_FOUND once the driver has been reassigned off the job', async () => {
      jobs.seed(job({ assignedDriverId: OTHER_PROFILE }));
      expect(await codeOf(() => submit())).toBe(ErrorCode.NOT_FOUND);
    });

    it.each([
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.DELIVERED,
      DeliveryJobStatus.CANCELLED,
      DeliveryJobStatus.FAILED,
    ])('13. refuses capture while the job is %s', async (status) => {
      jobs.seed(job({ status, assignedDriverId: DRIVER_PROFILE }));
      expect(await codeOf(() => submit())).toBe(ErrorCode.CONFLICT);
      expect(proofs.proofs.size).toBe(0);
      expect(storage.storeCalls).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 14-17. The artifact: validation, storage, and what never leaves this module
  // ---------------------------------------------------------------------------------------------

  describe('artifact handling', () => {
    it('14. stores a photo and records its handle, size and digest', async () => {
      const result = await submit(photo());

      expect(storage.storeCalls).toBe(1);
      expect(result.proof.artifactRef).toBe(`pod/${JOB_ID}/${PNG_SHA256}`);
      expect(result.proof.artifactSha256).toBe(PNG_SHA256);
      expect(result.proof.artifactContentType).toBe('image/png');
      expect(result.proof.artifactBytes).toBeGreaterThan(0);
    });

    it('15. refuses a content type outside the allow-list, before anything is stored', async () => {
      const code = await codeOf(() =>
        submit({
          type: PodType.PHOTO,
          artifact: { contentType: 'image/svg+xml', contentBase64: PNG_BASE64 },
        }),
      );

      expect(code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(storage.storeCalls).toBe(0);
      expect(proofs.proofs.size).toBe(0);
    });

    it('16. refuses an artifact larger than the configured cap, measured after decoding', async () => {
      config.values.set('delivery.podMaxArtifactBytes', 16);
      const code = await codeOf(() => submit(photo()));

      expect(code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(storage.storeCalls).toBe(0);
    });

    it('17. writes no audit entry for a rejected upload', async () => {
      await codeOf(() =>
        submit({
          type: PodType.PHOTO,
          artifact: { contentType: 'application/pdf', contentBase64: PNG_BASE64 },
        }),
      );
      expect(entries).toEqual([]);
    });

    it('18. audits the handle and the digest, and never the bytes', async () => {
      await submit(photo());

      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry.action).toBe('DELIVERY_POD_CAPTURED');
      expect(entry.context).toMatchObject({
        jobId: JOB_ID,
        artifactSha256: PNG_SHA256,
        artifactRef: `pod/${JOB_ID}/${PNG_SHA256}`,
      });
      // The bytes appear nowhere in the audit context, under any key.
      expect(JSON.stringify(entry.context)).not.toContain(PNG_BASE64.slice(0, 32));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 19-21. Idempotency and immutability
  // ---------------------------------------------------------------------------------------------

  describe('idempotency and immutability', () => {
    it('19. treats a resubmission of the same evidence as the retry it is', async () => {
      const first = await submit(photo());
      const second = await submit(photo());

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.proof.id).toBe(first.proof.id);
      expect(proofs.inserts).toBe(1);
      // No second audit entry, because nothing happened the second time.
      expect(entries).toHaveLength(1);
    });

    it('20. refuses a resubmission that would replace the evidence', async () => {
      await submit(photo());
      expect(await codeOf(() => submit(photo(OTHER_PNG_BASE64)))).toBe(ErrorCode.CONFLICT);
      // The original survives untouched.
      expect(proofs.proofs.get(JOB_ID)?.artifactSha256).toBe(PNG_SHA256);
    });

    it('21. refuses a resubmission that changes the recipient confirmation', async () => {
      await submit();
      expect(await codeOf(() => submit({ recipientConfirmed: false }))).toBe(ErrorCode.CONFLICT);
      expect(proofs.proofs.get(JOB_ID)?.recipientConfirmed).toBe(true);
    });

    it('22. settles a concurrent submission through the unique key rather than in memory', async () => {
      // Both callers read an empty table, so both reach the insert. The second loses the unique
      // constraint, re-reads, and — carrying identical evidence — succeeds idempotently.
      const [a, b] = await Promise.all([submit(photo()), submit(photo())]);

      expect(proofs.inserts).toBe(1);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.proof.artifactSha256).toBe(b.proof.artifactSha256);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 23-28. The DELIVERED gate
  // ---------------------------------------------------------------------------------------------

  describe('the DELIVERED transition', () => {
    it('23. delivers without proof while the policy requires none, and reads nothing', async () => {
      const result = await deliver();

      expect(result.job.status).toBe(DeliveryJobStatus.DELIVERED);
      // The gate returns before issuing a query at all — the common delivery pays nothing for a
      // policy nobody turned on.
      expect(proofs.reads).toBe(0);
    });

    it('24. refuses DELIVERED with POD_REQUIRED when required proof is missing', async () => {
      config.values.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');

      expect(await codeOf(deliver)).toBe(ErrorCode.POD_REQUIRED);
    });

    it('25. writes nothing at all when the requirement refuses', async () => {
      config.values.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');
      await codeOf(deliver);

      expect(jobs.jobs.get(JOB_ID)?.status).toBe(DeliveryJobStatus.ARRIVED_DROPOFF);
      expect(jobs.jobs.get(JOB_ID)?.deliveredAt).toBeNull();
      expect(jobs.history).toEqual([]);
      expect(events).toEqual([]);
      expect(entries).toEqual([]);
    });

    it('26. delivers once the required proof has been captured', async () => {
      config.values.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');
      await submit();

      const result = await deliver();

      expect(result.job.status).toBe(DeliveryJobStatus.DELIVERED);
      expect(events.map((e) => e.type)).toContain(DeliveryEventType.OrderDelivered);
    });

    it('27. is not satisfied by a confirmation-only proof when an artifact is required', async () => {
      config.values.set(POD_REQUIREMENT_CONFIG_KEY, 'ARTIFACT');
      await submit();

      expect(await codeOf(deliver)).toBe(ErrorCode.POD_REQUIRED);

      // The same delivery goes through once a photograph exists.
      proofs.proofs.clear();
      await submit(photo());
      expect((await deliver()).job.status).toBe(DeliveryJobStatus.DELIVERED);
    });

    it('28. applies the cold-chain rule only to a cold-chain delivery', async () => {
      config.values.set(POD_COLD_CHAIN_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');

      // An ordinary delivery is unaffected.
      expect((await deliver()).job.status).toBe(DeliveryJobStatus.DELIVERED);

      jobs.seed(job({ isColdChain: true }));
      expect(await codeOf(deliver)).toBe(ErrorCode.POD_REQUIRED);
    });

    it('29. applies the cash-on-delivery rule only to a COD delivery', async () => {
      config.values.set(POD_COD_REQUIREMENT_CONFIG_KEY, 'ARTIFACT');

      expect((await deliver()).job.status).toBe(DeliveryJobStatus.DELIVERED);

      // A COD job carries the amount the driver is collecting — the aggregate refuses the flag
      // without it, and the fixture must be a job the platform would actually have.
      jobs.seed(job({ isCod: true, codAmount: 24_500 }));
      expect(await codeOf(deliver)).toBe(ErrorCode.POD_REQUIRED);
    });

    it('30. still refuses an illegal transition ahead of the proof check', async () => {
      // The state machine remains the authority on reachability: a job that has not arrived
      // cannot be delivered, proof or no proof.
      config.values.set(POD_REQUIREMENT_CONFIG_KEY, 'CONFIRMATION');
      jobs.seed(job({ status: DeliveryJobStatus.ASSIGNED, pickedUpAt: null }));

      expect(await codeOf(deliver)).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 31-35. The authorized read
  // ---------------------------------------------------------------------------------------------

  describe('reading the proof back', () => {
    beforeEach(async () => {
      await submit(photo());
    });

    it('31. serves the customer who owns the order', async () => {
      const { view, viewer } = await read.byJobId(JOB_ID, CUSTOMER_USER);

      expect(viewer).toBe(DeliveryViewer.Customer);
      expect(view.jobId).toBe(JOB_ID);
      expect(view.type).toBe(PodType.PHOTO);
      expect(view.recipientName).toBe('Almaz Bekele');
    });

    it('32. serves the assigned driver', async () => {
      const { viewer } = await read.byJobId(JOB_ID, DRIVER_USER);
      expect(viewer).toBe(DeliveryViewer.Driver);
    });

    it('33. answers NOT_FOUND to everybody else, rather than FORBIDDEN', async () => {
      expect(await codeOf(() => read.byJobId(JOB_ID, STRANGER_USER))).toBe(ErrorCode.NOT_FOUND);
      expect(await codeOf(() => read.byJobId(JOB_ID, OTHER_USER))).toBe(ErrorCode.NOT_FOUND);
    });

    it('34. exposes the digest but never the storage handle or the bytes', async () => {
      const { view } = await read.byJobId(JOB_ID, CUSTOMER_USER);
      const serialized = JSON.stringify(view);

      expect(view.artifact).toMatchObject({ sha256: PNG_SHA256, available: true });
      expect(serialized).not.toContain('pod/');
      expect(serialized).not.toContain(PNG_BASE64.slice(0, 32));
      expect(Object.keys(view.artifact ?? {})).toEqual([
        'contentType',
        'bytes',
        'sha256',
        'available',
      ]);
    });

    it('35. reports an artifact storage can no longer account for, without failing the read', async () => {
      storage.describeReturnsNull = true;
      expect((await read.byJobId(JOB_ID, CUSTOMER_USER)).view.artifact?.available).toBe(false);

      storage.describeThrows = true;
      expect((await read.byJobId(JOB_ID, CUSTOMER_USER)).view.artifact?.available).toBe(false);
    });

    it('36. answers NOT_FOUND for a delivery that has no proof', async () => {
      proofs.proofs.clear();
      expect(await codeOf(() => read.byJobId(JOB_ID, CUSTOMER_USER))).toBe(ErrorCode.NOT_FOUND);
    });
  });
});
