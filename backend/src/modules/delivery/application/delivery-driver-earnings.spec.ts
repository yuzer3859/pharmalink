import { AuditService } from '../../../shared/audit/audit.service';
import { IConfigPort } from '../../../shared/config/config.port';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { DomainEvent } from '../../../shared/events/domain-event';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import {
  DriverEarning,
  DriverEarningProps,
} from '../domain/entities/driver-earning.entity';
import { DeliveryJobStatus, EarningStatus } from '../domain/enums';
import { DeliveryEventType, EarningAccruedPayload } from '../domain/events';
import {
  DeliveryJobPage,
  IDeliveryJobRepository,
} from '../domain/repositories/delivery-job.repository';
import {
  DriverEarningCriteria,
  DriverEarningPage,
  IDriverEarningRepository,
} from '../domain/repositories/driver-earning.repository';
import { DriverProfileProps } from '../domain/entities/driver-profile.entity';
import { IDriverProfileRepository } from '../domain/repositories/driver-profile.repository';
import {
  DriverEarningPolicy,
  DriverEarningSettings,
} from '../domain/services/driver-earning-policy';
import { AccrueDriverEarningCommand } from './commands/accrue-driver-earning.command';
import { IUnitOfWork } from './ports/unit-of-work.port';
import { GetDriverEarningsQuery } from './queries/get-driver-earnings.query';
import {
  EARNING_BASE_CONFIG_KEY,
  EARNING_FEE_SHARE_PERCENT_CONFIG_KEY,
  EARNING_MAXIMUM_CONFIG_KEY,
  EARNING_MINIMUM_CONFIG_KEY,
  EARNING_PER_KM_CONFIG_KEY,
  EARNING_ROUND_TO_CONFIG_KEY,
  EARNING_VERSION_CONFIG_KEY,
  resolveDriverEarningSettings,
} from './services/driver-earning-settings';

const JOB_ID = 'job-earn-1';
const ORDER_ID = 'order-earn-1';
const FULFILLMENT_ID = 'fulfillment-earn-1';
const DRIVER_USER = 'user-driver-1';
const DRIVER_PROFILE = 'driver-profile-1';

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
 * An in-memory earnings ledger that enforces the real unique index rather than merely storing
 * rows — so a concurrency bug fails here as well as against PostgreSQL.
 */
class FakeEarningRepository implements IDriverEarningRepository {
  readonly rows = new Map<string, DriverEarningProps>();
  /** Runs between the in-transaction re-check and the insert, to open the race window. */
  onInsert: (() => Promise<void>) | null = null;
  insertCalls = 0;

  async insert(earning: DriverEarningProps): Promise<DriverEarningProps | null> {
    this.insertCalls += 1;
    if (this.onInsert) {
      const hook = this.onInsert;
      this.onInsert = null;
      await hook();
    }
    if (this.rows.has(earning.jobId)) {
      return null;
    }
    this.rows.set(earning.jobId, earning);
    return earning;
  }

  async findByJobId(jobId: string): Promise<DriverEarningProps | null> {
    return this.rows.get(jobId) ?? null;
  }

  async listByDriver(criteria: DriverEarningCriteria): Promise<DriverEarningPage> {
    const mine = [...this.rows.values()]
      .filter((row) => row.driverId === criteria.driverId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: mine.slice(criteria.offset, criteria.offset + criteria.limit),
      total: mine.length,
    };
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
    isCod: false,
    codAmount: null,
    deliveryFee: 4_000,
    distanceMeters: 5_000,
    status: DeliveryJobStatus.DELIVERED,
    assignedDriverId: DRIVER_PROFILE,
    pickedUpAt: new Date(),
    deliveredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function settings(overrides: Partial<DriverEarningSettings> = {}): DriverEarningSettings {
  return {
    calculationVersion: 'v1',
    base: 0,
    perKm: 0,
    feeSharePercent: 0,
    minimum: 0,
    maximum: null,
    roundTo: 1,
    ...overrides,
  };
}

function harness() {
  const jobs = new FakeJobRepository();
  const earnings = new FakeEarningRepository();
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

  return {
    jobs,
    earnings,
    profiles,
    config,
    entries,
    events,
    accrue: new AccrueDriverEarningCommand(
      jobs as unknown as IDeliveryJobRepository,
      earnings,
      config,
      uow,
      audit,
      outbox,
    ),
    read: new GetDriverEarningsQuery(
      earnings,
      profiles as unknown as IDriverProfileRepository,
      jobs as unknown as IDeliveryJobRepository,
    ),
  };
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

describe('Module 08 — driver earnings accrual (F-ERN-01/F-ERN-02, BR-DEL-10)', () => {
  describe('the agreement as shipped', () => {
    it('1. accrues nothing, because no earning model has been approved', () => {
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: 12_000, deliveryFee: 8_000 },
        settings(),
      );

      expect(breakdown.total.amountMinor).toBe(0);
      expect(breakdown.total.currency).toBe('ETB');
    });

    it('2. still records what it was computed from, so a zero is explainable', () => {
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: 12_000, deliveryFee: 8_000 },
        settings(),
      );

      expect(breakdown.distanceMeters).toBe(12_000);
      expect(breakdown.calculationVersion).toBe('v1');
    });
  });

  describe('the calculation', () => {
    it('3. pays a flat base per completed delivery', () => {
      expect(
        DriverEarningPolicy.calculate({ distanceMeters: null, deliveryFee: 0 }, settings({ base: 2_500 }))
          .total.amountMinor,
      ).toBe(2_500);
    });

    it('4. adds a per-kilometre component over the frozen distance', () => {
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: 5_000, deliveryFee: 0 },
        settings({ base: 2_000, perKm: 800 }),
      );

      expect(breakdown.base).toBe(2_000);
      expect(breakdown.distanceComponent).toBe(4_000);
      expect(breakdown.total.amountMinor).toBe(6_000);
    });

    it('5. prorates a partial kilometre with exact integer arithmetic', () => {
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: 1_001, deliveryFee: 0 },
        settings({ perKm: 333 }),
      );

      expect(Number.isInteger(breakdown.total.amountMinor)).toBe(true);
      expect(breakdown.distanceComponent).toBe(333);
    });

    /**
     * §2's central rule. Under the shipped agreement a driver's earning has no arithmetic
     * relationship to what the customer paid, because who funds the driver is the design's own
     * unresolved Open Question 4.
     */
    it('6. does not equal the customer delivery fee by default', () => {
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: 5_000, deliveryFee: 9_999 },
        settings(),
      );

      expect(breakdown.feeShare).toBe(0);
      expect(breakdown.total.amountMinor).toBe(0);
      expect(breakdown.total.amountMinor).not.toBe(9_999);
    });

    it('7. passes a share of the fee through only when one is explicitly configured', () => {
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: null, deliveryFee: 10_000 },
        settings({ feeSharePercent: 0.7 }),
      );

      expect(breakdown.feeShare).toBe(7_000);
      expect(breakdown.total.amountMinor).toBe(7_000);
    });

    it('8. computes the share from the frozen fee, not from any current rate card', () => {
      // The job carries what the customer really paid; nothing else is consulted.
      const breakdown = DriverEarningPolicy.calculate(
        { distanceMeters: null, deliveryFee: 3_333 },
        settings({ feeSharePercent: 0.5 }),
      );

      expect(breakdown.feeShare).toBe(1_667); // Math.round, the platform's shared convention.
    });

    it('9. never produces an incentive, because no incentive rule exists', () => {
      expect(
        DriverEarningPolicy.calculate(
          { distanceMeters: 20_000, deliveryFee: 20_000 },
          settings({ base: 5_000, perKm: 900, feeSharePercent: 1 }),
        ).incentive,
      ).toBe(0);
    });

    it('10. rounds to the configured step', () => {
      expect(
        DriverEarningPolicy.calculate(
          { distanceMeters: 1_847, deliveryFee: 0 },
          settings({ perKm: 1_000, roundTo: 100 }),
        ).total.amountMinor,
      ).toBe(1_800);
    });

    it('11. applies the guaranteed minimum after rounding', () => {
      expect(
        DriverEarningPolicy.calculate(
          { distanceMeters: 100, deliveryFee: 0 },
          settings({ perKm: 1_000, roundTo: 100, minimum: 3_050 }),
        ).total.amountMinor,
      ).toBe(3_050);
    });

    it('12. caps a long delivery at the configured maximum', () => {
      expect(
        DriverEarningPolicy.calculate(
          { distanceMeters: 60_000, deliveryFee: 0 },
          settings({ perKm: 1_000, maximum: 9_000 }),
        ).total.amountMinor,
      ).toBe(9_000);
    });

    it('13. answers in the currency the platform settles in', () => {
      expect(
        DriverEarningPolicy.calculate({ distanceMeters: null, deliveryFee: 0 }, settings()).total
          .currency,
      ).toBe('ETB');
    });

    it('14. is deterministic — the same delivery and agreement give the same answer', () => {
      const first = DriverEarningPolicy.calculate(
        { distanceMeters: 4_321, deliveryFee: 2_500 },
        settings({ base: 1_000, perKm: 700, feeSharePercent: 0.2 }),
      );
      const second = DriverEarningPolicy.calculate(
        { distanceMeters: 4_321, deliveryFee: 2_500 },
        settings({ base: 1_000, perKm: 700, feeSharePercent: 0.2 }),
      );

      expect(second).toEqual(first);
    });
  });

  describe('a missing historical distance', () => {
    it('15. is fine while the agreement does not charge by distance', () => {
      expect(DriverEarningPolicy.requiresDistance(settings({ base: 2_000 }))).toBe(false);
      expect(
        DriverEarningPolicy.calculate({ distanceMeters: null, deliveryFee: 0 }, settings({ base: 2_000 }))
          .total.amountMinor,
      ).toBe(2_000);
    });

    it('16. is refused when the agreement needs one', () => {
      expect(DriverEarningPolicy.requiresDistance(settings({ perKm: 500 }))).toBe(true);
      expect(() =>
        DriverEarningPolicy.calculate({ distanceMeters: null, deliveryFee: 0 }, settings({ perKm: 500 })),
      ).toThrow(ApiException);
    });

    it('17. reports a retriable business-rule refusal from the command, writing nothing', async () => {
      const h = harness();
      h.config.set(EARNING_PER_KM_CONFIG_KEY, 500);
      h.jobs.seed(job({ distanceMeters: null }));

      await expectApiError(
        h.accrue.execute({ jobId: JOB_ID }),
        ErrorCode.BUSINESS_RULE_VIOLATION,
      );
      expect(h.earnings.rows.size).toBe(0);
      expect(h.entries).toHaveLength(0);
      expect(h.events).toHaveLength(0);
    });

    it('18. never substitutes a fresh distance or a silent zero', async () => {
      const h = harness();
      h.config.set(EARNING_PER_KM_CONFIG_KEY, 500);
      h.jobs.seed(job({ distanceMeters: null }));

      const err = await expectApiError(
        h.accrue.execute({ jobId: JOB_ID }),
        ErrorCode.BUSINESS_RULE_VIOLATION,
      );

      expect(err.details).toMatchObject({ jobId: JOB_ID, calculationVersion: 'v1' });
    });

    it('19. succeeds on a re-run once the agreement no longer needs a distance', async () => {
      const h = harness();
      h.config.set(EARNING_PER_KM_CONFIG_KEY, 500).set(EARNING_BASE_CONFIG_KEY, 2_000);
      h.jobs.seed(job({ distanceMeters: null }));
      await expectApiError(h.accrue.execute({ jobId: JOB_ID }), ErrorCode.BUSINESS_RULE_VIOLATION);

      h.config.set(EARNING_PER_KM_CONFIG_KEY, 0);
      const result = await h.accrue.execute({ jobId: JOB_ID });

      expect(result.created).toBe(true);
      expect(result.earning.total).toBe(2_000);
      expect(result.earning.distanceMeters).toBeNull();
    });
  });

  describe('the agreement as configuration', () => {
    it('20. resolves every key from the delivery namespace', () => {
      const config = new FakeConfig()
        .set(EARNING_BASE_CONFIG_KEY, 2_000)
        .set(EARNING_PER_KM_CONFIG_KEY, 800)
        .set(EARNING_FEE_SHARE_PERCENT_CONFIG_KEY, 0.25)
        .set(EARNING_MINIMUM_CONFIG_KEY, 2_500)
        .set(EARNING_MAXIMUM_CONFIG_KEY, 9_000)
        .set(EARNING_ROUND_TO_CONFIG_KEY, 100)
        .set(EARNING_VERSION_CONFIG_KEY, 'driver-terms-2026-q1');

      expect(resolveDriverEarningSettings(config)).toEqual({
        calculationVersion: 'driver-terms-2026-q1',
        base: 2_000,
        perKm: 800,
        feeSharePercent: 0.25,
        minimum: 2_500,
        maximum: 9_000,
        roundTo: 100,
      });
    });

    it('21. invents no rate when nothing is configured', () => {
      expect(resolveDriverEarningSettings(new FakeConfig())).toEqual({
        calculationVersion: 'v1',
        base: 0,
        perKm: 0,
        feeSharePercent: 0,
        minimum: 0,
        maximum: null,
        roundTo: 1,
      });
    });

    it('22. reads a maximum of zero as no cap at all', () => {
      expect(
        resolveDriverEarningSettings(new FakeConfig().set(EARNING_MAXIMUM_CONFIG_KEY, 0)).maximum,
      ).toBeNull();
    });

    it('23. keeps the earning version independent of the delivery-fee version', () => {
      const config = new FakeConfig()
        .set('delivery.feePricingVersion', 'rate-card-2026-q1')
        .set(EARNING_VERSION_CONFIG_KEY, 'driver-terms-2026-q1');

      expect(resolveDriverEarningSettings(config).calculationVersion).toBe(
        'driver-terms-2026-q1',
      );
    });
  });

  describe('accrual', () => {
    it('24. records an earning for a delivered job', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000).set(EARNING_PER_KM_CONFIG_KEY, 800);
      h.jobs.seed(job());

      const result = await h.accrue.execute({ jobId: JOB_ID });

      expect(result.created).toBe(true);
      expect(result.earning.total).toBe(2_000 + 4_000);
      expect(result.earning.status).toBe(EarningStatus.ACCRUED);
    });

    it('25. associates it with the assigned driver', async () => {
      const h = harness();
      h.jobs.seed(job());

      expect((await h.accrue.execute({ jobId: JOB_ID })).earning.driverId).toBe(DRIVER_PROFILE);
    });

    it('26. associates it with the delivery job, order and fulfillment', async () => {
      const h = harness();
      h.jobs.seed(job());

      expect(await h.accrue.execute({ jobId: JOB_ID }).then((r) => r.earning)).toMatchObject({
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
      });
    });

    it('27. uses the job’s frozen distance and fee, not anything re-derived', async () => {
      const h = harness();
      h.config.set(EARNING_PER_KM_CONFIG_KEY, 1_000).set(EARNING_FEE_SHARE_PERCENT_CONFIG_KEY, 0.5);
      h.jobs.seed(job({ distanceMeters: 7_000, deliveryFee: 6_000 }));

      const { earning } = await h.accrue.execute({ jobId: JOB_ID });

      expect(earning.distanceComponent).toBe(7_000);
      expect(earning.feeShare).toBe(3_000);
      expect(earning.distanceMeters).toBe(7_000);
    });

    it('28. stamps the agreement version the amount was computed under', async () => {
      const h = harness();
      h.config.set(EARNING_VERSION_CONFIG_KEY, 'driver-terms-2026-q1');
      h.jobs.seed(job());

      expect((await h.accrue.execute({ jobId: JOB_ID })).earning.calculationVersion).toBe(
        'driver-terms-2026-q1',
      );
    });

    it('29. refuses a job that has not been delivered', async () => {
      const h = harness();
      h.jobs.seed(job({ status: DeliveryJobStatus.EN_ROUTE }));

      await expectApiError(h.accrue.execute({ jobId: JOB_ID }), ErrorCode.CONFLICT);
      expect(h.earnings.rows.size).toBe(0);
    });

    it('30. accrues from a COMPLETED job, so a skipped accrual stays recoverable', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 1_500);
      h.jobs.seed(job({ status: DeliveryJobStatus.COMPLETED }));

      expect((await h.accrue.execute({ jobId: JOB_ID })).created).toBe(true);
    });

    it('31. refuses a job with no assigned driver rather than writing an unpayable earning', async () => {
      const h = harness();
      h.jobs.seed(job({ assignedDriverId: null }));

      await expectApiError(h.accrue.execute({ jobId: JOB_ID }), ErrorCode.CONFLICT);
    });

    it('32. answers NOT_FOUND for a job that does not exist', async () => {
      const h = harness();

      await expectApiError(h.accrue.execute({ jobId: 'nope' }), ErrorCode.NOT_FOUND);
    });

    it('33. takes no amount from its caller — the input is one job id', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000);
      h.jobs.seed(job());

      const { earning } = await h.accrue.execute({
        jobId: JOB_ID,
        ...({ total: 999_999, base: 999_999 } as unknown as Record<string, never>),
      });

      expect(earning.total).toBe(2_000);
    });
  });

  describe('idempotency and concurrency', () => {
    it('34. does not create a second earning for a repeated completion', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000);
      h.jobs.seed(job());

      const first = await h.accrue.execute({ jobId: JOB_ID });
      const second = await h.accrue.execute({ jobId: JOB_ID });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.earning.id).toBe(first.earning.id);
      expect(h.earnings.rows.size).toBe(1);
    });

    it('35. writes one audit entry and one event, however many times it is called', async () => {
      const h = harness();
      h.jobs.seed(job());

      await h.accrue.execute({ jobId: JOB_ID });
      await h.accrue.execute({ jobId: JOB_ID });
      await h.accrue.execute({ jobId: JOB_ID });

      expect(h.entries).toHaveLength(1);
      expect(h.events).toHaveLength(1);
    });

    it('36. converges on one earning when a competing writer wins mid-accrual', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000);
      h.jobs.seed(job());
      // A second accrual commits between this one's in-transaction re-check and its insert — the
      // exact window the unique index exists to close.
      h.earnings.onInsert = async () => {
        h.earnings.rows.set(JOB_ID, {
          ...DriverEarning.accrue({
            id: 'winner',
            driverId: DRIVER_PROFILE,
            jobId: JOB_ID,
            orderId: ORDER_ID,
            fulfillmentId: FULFILLMENT_ID,
            base: 2_000,
            total: 2_000,
            currency: 'ETB',
            calculationVersion: 'v1',
          }).toProps(),
        });
      };

      const result = await h.accrue.execute({ jobId: JOB_ID });

      expect(result.created).toBe(false);
      expect(result.earning.id).toBe('winner');
      expect(h.earnings.rows.size).toBe(1);
    });

    it('37. converges when three accruals run concurrently', async () => {
      const h = harness();
      h.jobs.seed(job());

      const results = await Promise.all([
        h.accrue.execute({ jobId: JOB_ID }),
        h.accrue.execute({ jobId: JOB_ID }),
        h.accrue.execute({ jobId: JOB_ID }),
      ]);

      expect(h.earnings.rows.size).toBe(1);
      expect(new Set(results.map((r) => r.earning.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });

    it('38. does not recompute on a replay — a rate change cannot rewrite a committed earning', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000);
      h.jobs.seed(job());
      const first = await h.accrue.execute({ jobId: JOB_ID });

      h.config.set(EARNING_BASE_CONFIG_KEY, 9_000);
      const replay = await h.accrue.execute({ jobId: JOB_ID });

      expect(replay.earning.total).toBe(first.earning.total);
      expect(replay.earning.total).toBe(2_000);
    });
  });

  describe('immutability', () => {
    it('39. exposes no mutator on the aggregate at all', () => {
      const earning = DriverEarning.accrue({
        id: 'e1',
        driverId: DRIVER_PROFILE,
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        base: 1_000,
        total: 1_000,
        currency: 'ETB',
        calculationVersion: 'v1',
      });

      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(earning)).filter(
        (name) => name !== 'constructor',
      );
      expect(methods).toEqual(['toProps']);
    });

    it('40. offers no update and no delete on the repository', () => {
      const repo: IDriverEarningRepository = new FakeEarningRepository();

      expect((repo as unknown as Record<string, unknown>).update).toBeUndefined();
      expect((repo as unknown as Record<string, unknown>).delete).toBeUndefined();
      expect((repo as unknown as Record<string, unknown>).markSettled).toBeUndefined();
    });

    it('41. always accrues at ACCRUED — settlement is not Delivery’s to assert', () => {
      const earning = DriverEarning.accrue({
        id: 'e1',
        driverId: DRIVER_PROFILE,
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        base: 0,
        total: 0,
        currency: 'ETB',
        calculationVersion: 'v1',
        ...({ status: EarningStatus.SETTLED } as unknown as Record<string, never>),
      });

      expect(earning.toProps().status).toBe(EarningStatus.ACCRUED);
    });

    it('42. refuses a negative amount, which would be a deduction nobody specified', () => {
      expect(() =>
        DriverEarning.accrue({
          id: 'e1',
          driverId: DRIVER_PROFILE,
          jobId: JOB_ID,
          orderId: ORDER_ID,
          fulfillmentId: FULFILLMENT_ID,
          base: -100,
          total: -100,
          currency: 'ETB',
          calculationVersion: 'v1',
        }),
      ).toThrow(ApiException);
    });
  });

  describe('the Module 07 handoff', () => {
    it('43. emits EarningAccrued exactly once', async () => {
      const h = harness();
      h.jobs.seed(job());

      await h.accrue.execute({ jobId: JOB_ID });
      await h.accrue.execute({ jobId: JOB_ID });

      const accrued = h.events.filter((e) => e.type === DeliveryEventType.EarningAccrued);
      expect(accrued).toHaveLength(1);
    });

    it('44. carries everything a settlement needs to act on it', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_500).set(EARNING_VERSION_CONFIG_KEY, 'terms-1');
      h.jobs.seed(job());

      const { earning } = await h.accrue.execute({ jobId: JOB_ID });
      const event = h.events.find((e) => e.type === DeliveryEventType.EarningAccrued);
      const payload = event?.payload as unknown as EarningAccruedPayload;

      expect(payload).toEqual({
        earningId: earning.id,
        driverId: DRIVER_PROFILE,
        jobId: JOB_ID,
        orderId: ORDER_ID,
        fulfillmentId: FULFILLMENT_ID,
        amount: 2_500,
        currency: 'ETB',
        calculationVersion: 'terms-1',
      });
      // The envelope carries the timestamp §8 asks for, as the ISO string every event uses.
      expect(typeof event?.occurredAt).toBe('string');
      expect(Number.isNaN(Date.parse(String(event?.occurredAt)))).toBe(false);
    });

    it('45. carries no payout, bank or wallet information', async () => {
      const h = harness();
      h.jobs.seed(job());
      await h.accrue.execute({ jobId: JOB_ID });

      const serialized = JSON.stringify(h.events[0]?.payload ?? {}).toLowerCase();
      for (const forbidden of ['bank', 'wallet', 'telebirr', 'payout', 'account', 'iban']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('46. records the components in the audit trail, not just the total', async () => {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000).set(EARNING_PER_KM_CONFIG_KEY, 800);
      h.jobs.seed(job());

      await h.accrue.execute({ jobId: JOB_ID });

      expect(h.entries[0]).toMatchObject({
        action: 'DELIVERY_EARNING_ACCRUED',
        context: {
          base: 2_000,
          distanceComponent: 4_000,
          feeShare: 0,
          incentive: 0,
          total: 6_000,
          currency: 'ETB',
          calculationVersion: 'v1',
        },
      });
    });
  });

  describe('reading earnings', () => {
    async function seeded() {
      const h = harness();
      h.config.set(EARNING_BASE_CONFIG_KEY, 2_000);
      h.jobs.seed(job());
      await h.accrue.execute({ jobId: JOB_ID });
      return h;
    }

    it('47. returns the driver’s own ledger', async () => {
      const h = await seeded();

      const view = await h.read.forDriver(DRIVER_USER);

      expect(view.total).toBe(1);
      expect(view.items[0].jobId).toBe(JOB_ID);
      expect(view.pageTotal).toBe(2_000);
      expect(view.currency).toBe('ETB');
    });

    it('48. never returns another driver’s earnings', async () => {
      const h = await seeded();
      h.profiles.seed('user-driver-2', 'driver-profile-2');

      expect((await h.read.forDriver('user-driver-2')).items).toEqual([]);
    });

    it('49. reads one delivery’s earning for its own driver', async () => {
      const h = await seeded();

      expect((await h.read.byJobId(JOB_ID, DRIVER_USER)).jobId).toBe(JOB_ID);
    });

    it('50. answers NOT_FOUND for another driver’s delivery — never FORBIDDEN', async () => {
      const h = await seeded();
      h.profiles.seed('user-driver-2', 'driver-profile-2');

      await expectApiError(h.read.byJobId(JOB_ID, 'user-driver-2'), ErrorCode.NOT_FOUND);
    });

    it('51. answers NOT_FOUND identically for a delivery with no earning yet', async () => {
      const h = harness();
      h.jobs.seed(job());

      await expectApiError(h.read.byJobId(JOB_ID, DRIVER_USER), ErrorCode.NOT_FOUND);
    });

    it('52. refuses a caller who is not an operational driver', async () => {
      const h = await seeded();

      await expectApiError(h.read.forDriver('user-nobody'), ErrorCode.NOT_FOUND);
    });

    it('53. clamps paging rather than trusting it', async () => {
      const h = await seeded();

      expect((await h.read.forDriver(DRIVER_USER, { limit: 10_000 })).limit).toBe(100);
      expect((await h.read.forDriver(DRIVER_USER, { limit: -1 })).limit).toBe(20);
      expect((await h.read.forDriver(DRIVER_USER, { offset: -5 })).offset).toBe(0);
    });
  });
});
