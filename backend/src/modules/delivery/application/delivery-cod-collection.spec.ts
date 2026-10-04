import { AuditService } from '../../../shared/audit/audit.service';
import { IConfigPort } from '../../../shared/config/config.port';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DomainEvent } from '../../../shared/events/domain-event';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import {
  CodCollection,
  CodCollectionProps,
  hasDiscrepancy,
  varianceOf,
} from '../domain/entities/cod-collection.entity';
import { DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import {
  CodCollectionMethod,
  CodCollectionStatus,
  DeliveryJobStatus,
} from '../domain/enums';
import { CodCollectedPayload, DeliveryEventType } from '../domain/events';
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
import {
  DeliveryJobPage,
  IDeliveryJobRepository,
} from '../domain/repositories/delivery-job.repository';
import { IDriverProfileRepository } from '../domain/repositories/driver-profile.repository';
import {
  CodAmountOutcome,
  CodCollectionPolicy,
  CodPolicySettings,
} from '../domain/services/cod-collection-policy';
import { RecordCodCollectionCommand } from './commands/record-cod-collection.command';
import { IIdentityPort } from './ports/outbound/identity.port';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { GetCodCollectionQuery } from './queries/get-cod-collection.query';
import {
  COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY,
  COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY,
  resolveCodSettings,
} from './services/cod-settings';

const JOB_ID = 'job-cod-1';
const ORDER_ID = 'order-cod-1';
const FULFILLMENT_ID = 'fulfillment-cod-1';
const DRIVER_USER = 'user-driver-1';
const DRIVER_PROFILE = 'driver-profile-1';
const COD_AMOUNT = 24_500;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeJobRepository {
  readonly jobs = new Map<string, DeliveryJobProps>();

  seed(props: DeliveryJobProps): void {
    this.jobs.set(props.id, props);
  }
  async findById(id: string): Promise<DeliveryJobProps | null> {
    return this.jobs.get(id) ?? null;
  }
  async findByFulfillmentId(): Promise<DeliveryJobProps | null> {
    return null;
  }
  async findByOrderId(): Promise<DeliveryJobProps[]> {
    return [];
  }
  async create(job: DeliveryJobProps): Promise<DeliveryJobProps> {
    this.jobs.set(job.id, job);
    return job;
  }
  async updateState(): Promise<DeliveryJobProps | null> {
    return null;
  }
  async appendStatusHistory(): Promise<void> {}
  async listStatusHistory(): Promise<never[]> {
    return [];
  }
  async list(): Promise<DeliveryJobPage> {
    return { items: [], total: 0 };
  }
  async countActiveJobs(): Promise<number> {
    return 0;
  }
  async countActiveJobsByDriver(): Promise<Map<string, number>> {
    return new Map();
  }
}

/**
 * An in-memory COD ledger that enforces the real unique index rather than merely storing rows —
 * so a concurrency bug fails here as well as against PostgreSQL.
 */
class FakeCodCollectionRepository implements ICodCollectionRepository {
  readonly rows = new Map<string, CodCollectionProps>();
  /** Runs before the insert, to open the race window a competing writer would win. */
  onInsert: (() => Promise<void>) | null = null;

  async insert(collection: CodCollectionProps): Promise<CodCollectionProps | null> {
    if (this.onInsert) {
      const hook = this.onInsert;
      this.onInsert = null;
      await hook();
    }
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

  /**
   * The one correction-side method this suite genuinely exercises: the driver's own read reports
   * `hasOpenDispute`, and a driver in these scenarios has none. Implemented rather than thrown, so
   * the assertion that a driver is told `false` is a real assertion.
   */
  async findOpenDispute(): Promise<CodDisputeProps | null> {
    return null;
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

class FakeProfileRepository {
  readonly byUser = new Map<string, DriverProfileProps>();

  seed(userId: string, id: string): void {
    this.byUser.set(userId, { id, userId } as DriverProfileProps);
  }
  async findByUserId(userId: string): Promise<DriverProfileProps | null> {
    return this.byUser.get(userId) ?? null;
  }
  async findById(id: string): Promise<DriverProfileProps | null> {
    return [...this.byUser.values()].find((p) => p.id === id) ?? null;
  }
  async create(): Promise<DriverProfileProps> {
    throw new Error('not used');
  }
  async update(): Promise<DriverProfileProps | null> {
    return null;
  }
  async findDispatchCandidates(): Promise<DriverProfileProps[]> {
    return [];
  }
  async save(profile: DriverProfileProps): Promise<DriverProfileProps> {
    return profile;
  }
  async updateLocation(): Promise<DriverProfileProps | null> {
    return null;
  }
}

class FakeConfig implements IConfigPort {
  readonly values = new Map<string, unknown>();

  set(key: string, value: unknown): this {
    this.values.set(key, value);
    return this;
  }
  get<T = string>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`Missing config: ${key}`);
    }
    return value;
  }
  isFeatureEnabled(): boolean {
    return false;
  }
}

function fakeIdentity(eligible = true): IIdentityPort {
  return {
    getDriverIdentity: async () => ({
      isEligible: eligible,
      reason: eligible ? null : 'NOT_VERIFIED',
    }),
  } as unknown as IIdentityPort;
}

const uow: IUnitOfWork = { run: (work) => work('tx') };

function job(overrides: Partial<DeliveryJobProps> = {}): DeliveryJobProps {
  return {
    id: JOB_ID,
    orderId: ORDER_ID,
    fulfillmentId: FULFILLMENT_ID,
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    pickupPoint: null,
    pickupAddress: null,
    dropoffPoint: null,
    dropoffAddress: null,
    items: [],
    isColdChain: false,
    isCod: true,
    codAmount: COD_AMOUNT,
    deliveryFee: 0,
    distanceMeters: null,
    status: DeliveryJobStatus.ARRIVED_DROPOFF,
    assignedDriverId: DRIVER_PROFILE,
    pickedUpAt: new Date(),
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function settings(overrides: Partial<CodPolicySettings> = {}): CodPolicySettings {
  return { requireExactAmount: false, requireCollectionForCompletion: false, ...overrides };
}

function harness(identity: IIdentityPort = fakeIdentity()) {
  const jobs = new FakeJobRepository();
  const collections = new FakeCodCollectionRepository();
  const profiles = new FakeProfileRepository();
  const config = new FakeConfig();
  const entries: Array<{ action: string; context: Record<string, unknown> | null }> = [];
  const events: DomainEvent<Record<string, unknown>>[] = [];

  const audit = {
    record: jest.fn(async (entry: { action: string; context?: unknown }) => {
      entries.push({
        action: entry.action,
        context: (entry.context ?? null) as Record<string, unknown> | null,
      });
    }),
  } as unknown as AuditService;
  const outbox = {
    write: jest.fn(async (event: DomainEvent<Record<string, unknown>>) => {
      events.push(event);
    }),
  } as unknown as OutboxService;

  profiles.seed(DRIVER_USER, DRIVER_PROFILE);
  jobs.seed(job());

  return {
    jobs,
    collections,
    profiles,
    config,
    entries,
    events,
    record: new RecordCodCollectionCommand(
      jobs as unknown as IDeliveryJobRepository,
      profiles as unknown as IDriverProfileRepository,
      collections,
      identity,
      config,
      uow,
      audit,
      outbox,
    ),
    read: new GetCodCollectionQuery(
      collections,
      profiles as unknown as IDriverProfileRepository,
      jobs as unknown as IDeliveryJobRepository,
    ),
  };
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    userId: DRIVER_USER,
    jobId: JOB_ID,
    collectedAmount: COD_AMOUNT,
    method: CodCollectionMethod.CASH,
    ...overrides,
  } as Parameters<RecordCodCollectionCommand['execute']>[0];
}

async function expectApiError(promise: Promise<unknown>, code: ErrorCode): Promise<ApiException> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiException);
    expect((err as ApiException).code).toBe(code);
    return err as ApiException;
  }
  throw new Error(`Expected ${code} but the call succeeded.`);
}

// ---------------------------------------------------------------------------

describe('Module 08 — COD collection recording (F-COD-01, BR-DEL-10)', () => {
  describe('recording', () => {
    it('1. records an exact collection', async () => {
      const h = harness();

      const result = await h.record.execute(submission());

      expect(result.created).toBe(true);
      expect(result.collection).toMatchObject({
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        driverId: DRIVER_PROFILE,
        expectedAmount: COD_AMOUNT,
        collectedAmount: COD_AMOUNT,
        currency: 'ETB',
        status: CodCollectionStatus.COLLECTED,
      });
    });

    /** §4: the expected figure is the job's, frozen from `Order.grandTotal` at creation. */
    it('2. takes the expected amount from the delivery job, not the request', async () => {
      const h = harness();
      h.jobs.seed(job({ codAmount: 31_000 }));

      expect((await h.record.execute(submission())).collection.expectedAmount).toBe(31_000);
    });

    it('3. has no input through which a client could supply an expected amount', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({ expectedAmount: 1, driverId: 'somebody-else', status: 'RECONCILED' }),
      );

      expect(collection.expectedAmount).toBe(COD_AMOUNT);
      expect(collection.driverId).toBe(DRIVER_PROFILE);
      expect(collection.status).toBe(CodCollectionStatus.COLLECTED);
    });

    it('4. resolves the driver from the token', async () => {
      const h = harness();

      expect((await h.record.execute(submission())).collection.driverId).toBe(DRIVER_PROFILE);
    });

    it('5. refuses a driver who is not carrying the job, as NOT_FOUND', async () => {
      const h = harness();
      h.profiles.seed('user-driver-2', 'driver-profile-2');

      await expectApiError(
        h.record.execute(submission({ userId: 'user-driver-2' })),
        ErrorCode.NOT_FOUND,
      );
      expect(h.collections.rows.size).toBe(0);
    });

    it('6. refuses a driver whose verification was revoked', async () => {
      const h = harness(fakeIdentity(false));

      await expectApiError(h.record.execute(submission()), ErrorCode.DRIVER_NOT_VERIFIED);
    });

    it('7. refuses a caller with no operational driver profile', async () => {
      const h = harness();

      await expectApiError(
        h.record.execute(submission({ userId: 'user-nobody' })),
        ErrorCode.NOT_FOUND,
      );
    });

    it('8. refuses a delivery that is not cash on delivery', async () => {
      const h = harness();
      h.jobs.seed(job({ isCod: false, codAmount: null }));

      await expectApiError(h.record.execute(submission()), ErrorCode.CONFLICT);
      expect(h.collections.rows.size).toBe(0);
    });
  });

  describe('the delivery stage', () => {
    it.each([
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
    ])('9. refuses a collection at %s', async (status) => {
      const h = harness();
      h.jobs.seed(job({ status }));

      await expectApiError(h.record.execute(submission()), ErrorCode.CONFLICT);
      expect(h.collections.rows.size).toBe(0);
    });

    it('10. refuses a collection after the delivery has been posted', async () => {
      const h = harness();
      h.jobs.seed(job({ status: DeliveryJobStatus.DELIVERED, deliveredAt: new Date() }));

      await expectApiError(h.record.execute(submission()), ErrorCode.CONFLICT);
    });

    it('11. allows it at ARRIVED_DROPOFF — the same window proof of delivery uses', () => {
      for (const status of Object.values(DeliveryJobStatus)) {
        expect(CodCollectionPolicy.isRecordingAllowedIn(status)).toBe(
          status === DeliveryJobStatus.ARRIVED_DROPOFF,
        );
      }
    });

    it('12. changes no delivery status of its own', async () => {
      const h = harness();

      await h.record.execute(submission());

      expect(h.jobs.jobs.get(JOB_ID)!.status).toBe(DeliveryJobStatus.ARRIVED_DROPOFF);
    });
  });

  describe('amounts', () => {
    it('13. classifies exact, under and over', () => {
      expect(CodCollectionPolicy.classifyAmount(100, 100)).toBe(CodAmountOutcome.Exact);
      expect(CodCollectionPolicy.classifyAmount(100, 90)).toBe(CodAmountOutcome.Under);
      expect(CodCollectionPolicy.classifyAmount(100, 110)).toBe(CodAmountOutcome.Over);
    });

    it('14. records an underpayment rather than refusing it', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({ collectedAmount: COD_AMOUNT - 500 }),
      );

      expect(collection.collectedAmount).toBe(COD_AMOUNT - 500);
      expect(varianceOf(collection)).toBe(-500);
      expect(hasDiscrepancy(collection)).toBe(true);
    });

    it('15. records an overpayment the same way', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({ collectedAmount: COD_AMOUNT + 300 }),
      );

      expect(varianceOf(collection)).toBe(300);
      expect(hasDiscrepancy(collection)).toBe(true);
    });

    /** §7: never a fake successful payment so that the paperwork closes. */
    it('16. refuses to call a discrepant collection reconcilable, whatever the configuration', async () => {
      const h = harness();
      const { collection } = await h.record.execute(
        submission({ collectedAmount: COD_AMOUNT - 1 }),
      );

      expect(CodCollectionPolicy.isReconcilable(collection)).toBe(false);
    });

    it('17. calls an exact collection reconcilable', async () => {
      const h = harness();
      const { collection } = await h.record.execute(submission());

      expect(CodCollectionPolicy.isReconcilable(collection)).toBe(true);
    });

    it('18. refuses a discrepancy when the operator requires exact payment', async () => {
      const h = harness();
      h.config.set(COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY, true);

      await expectApiError(
        h.record.execute(submission({ collectedAmount: COD_AMOUNT - 500 })),
        ErrorCode.BUSINESS_RULE_VIOLATION,
      );
      expect(h.collections.rows.size).toBe(0);
      expect(h.events).toHaveLength(0);
    });

    it('19. still accepts an exact amount under that rule', async () => {
      const h = harness();
      h.config.set(COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY, true);

      expect((await h.record.execute(submission())).created).toBe(true);
    });

    it('20. accepts a zero collection — a real statement, not a missing one', async () => {
      const h = harness();

      const { collection } = await h.record.execute(submission({ collectedAmount: 0 }));

      expect(collection.collectedAmount).toBe(0);
      expect(varianceOf(collection)).toBe(-COD_AMOUNT);
    });

    it('21. refuses a negative or fractional amount', async () => {
      const h = harness();

      await expectApiError(
        h.record.execute(submission({ collectedAmount: -1 })),
        ErrorCode.VALIDATION_ERROR,
      );
      await expectApiError(
        h.record.execute(submission({ collectedAmount: 10.5 })),
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('methods', () => {
    it('22. records a cash collection with no provider reference', async () => {
      const h = harness();

      const { collection } = await h.record.execute(submission());

      expect(collection.method).toBe(CodCollectionMethod.CASH);
      expect(collection.providerReference).toBeNull();
    });

    /** §8: cash means the driver declared it, never that the platform verified it. */
    it('23. never marks cash reconciled merely because the driver submitted it', async () => {
      const h = harness();

      const { collection } = await h.record.execute(submission());

      expect(collection.status).toBe(CodCollectionStatus.COLLECTED);
      expect(collection.remittedAt).toBeNull();
      expect(collection.reconciledAt).toBeNull();
      expect(collection.settlementRef).toBeNull();
    });

    it('24. records an electronic collection with its opaque reference', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({ method: CodCollectionMethod.ELECTRONIC, providerReference: 'TXN-99881' }),
      );

      expect(collection.method).toBe(CodCollectionMethod.ELECTRONIC);
      expect(collection.providerReference).toBe('TXN-99881');
    });

    it('25. leaves an electronic collection just as unreconciled as cash', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({ method: CodCollectionMethod.ELECTRONIC, providerReference: 'TXN-1' }),
      );

      expect(collection.status).toBe(CodCollectionStatus.COLLECTED);
    });

    it('26. refuses a provider reference on a cash collection', async () => {
      const h = harness();

      await expectApiError(
        h.record.execute(submission({ providerReference: 'TXN-1' })),
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('27. treats a blank reference as absent', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({ method: CodCollectionMethod.ELECTRONIC, providerReference: '   ' }),
      );

      expect(collection.providerReference).toBeNull();
    });

    it('28. refuses a method outside the two the platform knows', async () => {
      const h = harness();

      await expectApiError(
        h.record.execute(submission({ method: 'TELEBIRR' })),
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });

  describe('idempotency and concurrency', () => {
    it('29. returns the stored record for an identical resubmission', async () => {
      const h = harness();

      const first = await h.record.execute(submission());
      const second = await h.record.execute(submission());

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.collection.id).toBe(first.collection.id);
      expect(h.collections.rows.size).toBe(1);
    });

    it('30. writes one audit entry and one event however many times it is called', async () => {
      const h = harness();

      await h.record.execute(submission());
      await h.record.execute(submission());
      await h.record.execute(submission());

      expect(h.entries).toHaveLength(1);
      expect(h.events).toHaveLength(1);
    });

    /** §15: restating how much cash changed hands is a correction, not an edit. */
    it('31. refuses a resubmission carrying a different amount', async () => {
      const h = harness();
      await h.record.execute(submission());

      await expectApiError(
        h.record.execute(submission({ collectedAmount: COD_AMOUNT - 100 })),
        ErrorCode.CONFLICT,
      );
      expect(h.collections.rows.get(JOB_ID)!.collectedAmount).toBe(COD_AMOUNT);
    });

    it('32. refuses a resubmission carrying a different method or reference', async () => {
      const h = harness();
      await h.record.execute(submission());

      await expectApiError(
        h.record.execute(
          submission({ method: CodCollectionMethod.ELECTRONIC, providerReference: 'TXN-1' }),
        ),
        ErrorCode.CONFLICT,
      );
    });

    it('33. converges when a competing writer wins mid-insert', async () => {
      const h = harness();
      h.collections.onInsert = async () => {
        h.collections.rows.set(JOB_ID, {
          ...CodCollection.record({
            id: 'winner',
            jobId: JOB_ID,
            orderId: ORDER_ID,
            fulfillmentId: FULFILLMENT_ID,
            driverId: DRIVER_PROFILE,
            expectedAmount: COD_AMOUNT,
            collectedAmount: COD_AMOUNT,
            currency: 'ETB',
            method: CodCollectionMethod.CASH,
          }).toProps(),
        });
      };

      const result = await h.record.execute(submission());

      expect(result.created).toBe(false);
      expect(result.collection.id).toBe('winner');
      expect(h.collections.rows.size).toBe(1);
    });

    it('34. converges when three submissions run concurrently', async () => {
      const h = harness();

      const results = await Promise.all([
        h.record.execute(submission()),
        h.record.execute(submission()),
        h.record.execute(submission()),
      ]);

      expect(h.collections.rows.size).toBe(1);
      expect(new Set(results.map((r) => r.collection.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(h.events).toHaveLength(1);
    });
  });

  describe('immutability', () => {
    it('35. exposes no mutator on the aggregate', () => {
      const collection = CodCollection.record({
        id: 'c1',
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        driverId: DRIVER_PROFILE,
        expectedAmount: COD_AMOUNT,
        collectedAmount: COD_AMOUNT,
        currency: 'ETB',
        method: CodCollectionMethod.CASH,
      });

      const members = Object.getOwnPropertyNames(Object.getPrototypeOf(collection)).filter(
        (name) => name !== 'constructor',
      );
      expect(members.sort()).toEqual(['hasDiscrepancy', 'toProps', 'variance']);
    });

    it('36. offers no update, delete or status transition on the repository', () => {
      const repo: ICodCollectionRepository = new FakeCodCollectionRepository();
      const surface = repo as unknown as Record<string, unknown>;

      for (const forbidden of ['update', 'delete', 'markRemitted', 'markReconciled', 'reconcile']) {
        expect(surface[forbidden]).toBeUndefined();
      }
    });

    /** §17 and §3: a collection channel must never certify its own remittance. */
    it('37. always records at COLLECTED, whatever a caller asks for', () => {
      const collection = CodCollection.record({
        id: 'c1',
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        driverId: DRIVER_PROFILE,
        expectedAmount: 0,
        collectedAmount: 0,
        currency: 'ETB',
        method: CodCollectionMethod.CASH,
        ...({ status: CodCollectionStatus.RECONCILED } as unknown as Record<string, never>),
      });

      expect(collection.toProps().status).toBe(CodCollectionStatus.COLLECTED);
    });
  });

  describe('the Module 07 handoff', () => {
    it('38. emits CodCollected exactly once', async () => {
      const h = harness();

      await h.record.execute(submission());
      await h.record.execute(submission());

      expect(h.events.filter((e) => e.type === DeliveryEventType.CodCollected)).toHaveLength(1);
    });

    it('39. carries both amounts, so a shortfall is visible downstream', async () => {
      const h = harness();

      const { collection } = await h.record.execute(
        submission({
          method: CodCollectionMethod.ELECTRONIC,
          providerReference: 'TXN-42',
          collectedAmount: COD_AMOUNT - 500,
        }),
      );
      const event = h.events.find((e) => e.type === DeliveryEventType.CodCollected);
      const payload = event?.payload as unknown as CodCollectedPayload;

      expect(payload).toEqual({
        collectionId: collection.id,
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        driverId: DRIVER_PROFILE,
        expectedAmount: COD_AMOUNT,
        collectedAmount: COD_AMOUNT - 500,
        currency: 'ETB',
        method: CodCollectionMethod.ELECTRONIC,
        providerReference: 'TXN-42',
        collectedAt: collection.collectedAt.toISOString(),
      });
    });

    it('40. carries no card, secret, callback or customer detail', async () => {
      const h = harness();
      await h.record.execute(
        submission({ method: CodCollectionMethod.ELECTRONIC, providerReference: 'TXN-42' }),
      );

      const serialized = JSON.stringify(h.events[0]?.payload ?? {}).toLowerCase();
      for (const forbidden of [
        'pan',
        'cvv',
        'secret',
        'callback',
        'signature',
        'token',
        'telebirr',
        'customer',
        'password',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('41. records both amounts and the variance in the audit trail', async () => {
      const h = harness();

      await h.record.execute(submission({ collectedAmount: COD_AMOUNT - 500 }));

      expect(h.entries[0]).toMatchObject({
        action: 'DELIVERY_COD_COLLECTED',
        context: {
          expectedAmount: COD_AMOUNT,
          collectedAmount: COD_AMOUNT - 500,
          variance: -500,
          currency: 'ETB',
          status: CodCollectionStatus.COLLECTED,
        },
      });
    });

    it('42. writes no audit entry for a rejected submission', async () => {
      const h = harness();
      h.jobs.seed(job({ status: DeliveryJobStatus.EN_ROUTE }));

      await expectApiError(h.record.execute(submission()), ErrorCode.CONFLICT);

      expect(h.entries).toHaveLength(0);
      expect(h.events).toHaveLength(0);
    });
  });

  describe('configuration', () => {
    it('43. defaults both rules off', () => {
      expect(resolveCodSettings(new FakeConfig())).toEqual({
        requireExactAmount: false,
        requireCollectionForCompletion: false,
      });
    });

    it('44. reads both from the delivery namespace', () => {
      const config = new FakeConfig()
        .set(COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY, true)
        .set(COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY, true);

      expect(resolveCodSettings(config)).toEqual({
        requireExactAmount: true,
        requireCollectionForCompletion: true,
      });
    });

    it('45. treats the string "false" as false, not as a non-empty string', () => {
      const config = new FakeConfig()
        .set(COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY, 'false')
        .set(COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY, 'true');

      expect(resolveCodSettings(config)).toEqual({
        requireExactAmount: false,
        requireCollectionForCompletion: true,
      });
    });

    it('46. never lets configuration make a discrepancy reconcilable', async () => {
      const h = harness();
      h.config
        .set(COD_REQUIRE_EXACT_AMOUNT_CONFIG_KEY, false)
        .set(COD_REQUIRE_COLLECTION_FOR_COMPLETION_CONFIG_KEY, true);

      const { collection } = await h.record.execute(
        submission({ collectedAmount: COD_AMOUNT - 1 }),
      );

      expect(CodCollectionPolicy.isReconcilable(collection)).toBe(false);
    });

    it('47. is a pure policy — isAmountAcceptable reads no configuration of its own', () => {
      expect(CodCollectionPolicy.isAmountAcceptable(100, 90, settings())).toBe(true);
      expect(
        CodCollectionPolicy.isAmountAcceptable(100, 90, settings({ requireExactAmount: true })),
      ).toBe(false);
    });
  });

  describe('reading', () => {
    it('48. returns the collection to the driver who recorded it', async () => {
      const h = harness();
      await h.record.execute(submission({ collectedAmount: COD_AMOUNT - 200 }));

      const view = await h.read.byJobId(JOB_ID, DRIVER_USER);

      expect(view.collection.jobId).toBe(JOB_ID);
      expect(view.variance).toBe(-200);
      expect(view.hasDiscrepancy).toBe(true);
      expect(view.isReconcilable).toBe(false);
    });

    it('49. answers NOT_FOUND for another driver’s delivery — never FORBIDDEN', async () => {
      const h = harness();
      await h.record.execute(submission());
      h.profiles.seed('user-driver-2', 'driver-profile-2');

      await expectApiError(h.read.byJobId(JOB_ID, 'user-driver-2'), ErrorCode.NOT_FOUND);
    });

    it('50. answers NOT_FOUND identically for a delivery with nothing recorded', async () => {
      const h = harness();

      await expectApiError(h.read.byJobId(JOB_ID, DRIVER_USER), ErrorCode.NOT_FOUND);
    });
  });
});
