import { AuditService } from '../../../shared/audit/audit.service';
import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { DeliveryJobProps } from '../domain/entities/delivery-job.entity';
import { DeliveryEventType } from '../domain/events';
import { DeliveryJobStatus } from '../domain/enums';
import {
  DeliveryJobPage,
  DeliveryJobStateExpectation,
  DeliveryJobStateUpdate,
  IDeliveryJobRepository,
  ListDeliveryJobsCriteria,
} from '../domain/repositories/delivery-job.repository';
import { CreateDeliveryJobCommand } from './commands/create-delivery-job.command';
import { ICatalogPort } from './ports/outbound/catalog.port';
import { DeliverableFulfillmentView, IOrdersPort } from './ports/outbound/orders.port';
import { BranchPickupView, IPharmacyPort } from './ports/outbound/pharmacy.port';
import { ACTIVE_JOB_STATUSES } from '../domain/services/driver-availability-policy';
import {
  IRoutingPort,
  RouteRequest,
  RouteResult,
} from './ports/outbound/routing.port';
import { IUnitOfWork } from './ports/unit-of-work.port';

const FULFILLMENT = 'fulfillment-1';

/**
 * An in-memory repository that enforces the real unique index rather than merely storing rows —
 * so a concurrency bug fails here as well as against PostgreSQL.
 */
class FakeDeliveryJobRepository implements IDeliveryJobRepository {
  readonly jobs = new Map<string, DeliveryJobProps>();
  /** Set to run inside `create`, to interleave a competing writer deterministically. */
  onCreate: (() => Promise<void>) | null = null;

  async findByFulfillmentId(fulfillmentId: string): Promise<DeliveryJobProps | null> {
    return (
      [...this.jobs.values()].find((job) => job.fulfillmentId === fulfillmentId) ?? null
    );
  }
  async findById(id: string): Promise<DeliveryJobProps | null> {
    return this.jobs.get(id) ?? null;
  }
  async countActiveJobsByDriver(ids: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const id of ids) {
      const n = await this.countActiveJobs(id);
      if (n > 0) {
        counts.set(id, n);
      }
    }
    return counts;
  }
  async findByOrderId(orderId: string): Promise<DeliveryJobProps[]> {
    return [...this.jobs.values()].filter((job) => job.orderId === orderId);
  }
  async listStatusHistory(): Promise<[]> {
    // Job creation makes no transition, so there is never any history on this path.
    return [];
  }
  async appendStatusHistory(): Promise<void> {
    // Job creation makes no transition, so nothing writes history on this path.
  }
  async countActiveJobs(driverProfileId: string): Promise<number> {
    // Present because the port requires it. Job creation never assigns a driver, so this is
    // exercised by the driver-operational-profile tests rather than here.
    return [...this.jobs.values()].filter(
      (job) =>
        job.assignedDriverId === driverProfileId &&
        ACTIVE_JOB_STATUSES.includes(job.status),
    ).length;
  }
  async list(criteria: ListDeliveryJobsCriteria): Promise<DeliveryJobPage> {
    const all = [...this.jobs.values()].filter(
      (job) =>
        criteria.pharmacyIds === undefined || criteria.pharmacyIds.includes(job.pharmacyId),
    );
    const start = (criteria.page - 1) * criteria.size;
    return { items: all.slice(start, start + criteria.size), total: all.length };
  }
  async create(job: DeliveryJobProps): Promise<DeliveryJobProps> {
    if (this.onCreate) {
      const hook = this.onCreate;
      this.onCreate = null;
      await hook();
    }
    // The unique index, as a real assertion rather than a hopeful one — and **atomic**: there is
    // deliberately no `await` between the check and the insert. A unique index cannot interleave,
    // so a fake that yielded here would be a weaker guarantee than production and would let a
    // genuine concurrency bug pass.
    const duplicate = [...this.jobs.values()].some(
      (existing) => existing.fulfillmentId === job.fulfillmentId,
    );
    if (duplicate) {
      const err = new Error('Unique constraint failed') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    }
    this.jobs.set(job.id, { ...job });
    return job;
  }
  async updateState(
    id: string,
    expected: DeliveryJobStateExpectation,
    update: DeliveryJobStateUpdate,
  ): Promise<DeliveryJobProps | null> {
    const job = this.jobs.get(id);
    if (!job || job.status !== expected.status) {
      return null;
    }
    if (expected.assignedDriverId !== undefined && job.assignedDriverId !== expected.assignedDriverId) {
      return null;
    }
    const next = { ...job, ...update };
    this.jobs.set(id, next);
    return next;
  }

  // Work 14's recovery discovery. The sweepers are covered against a real PostgreSQL in
  // `test/delivery/delivery-recovery.e2e-spec.ts` — `FOR UPDATE SKIP LOCKED` has no meaning in an
  // in-memory fake, and a stub that pretended otherwise would assert nothing.
  lockNextStranded(): Promise<never> {
    throw new Error('lockNextStranded is not used in these unit tests.');
  }

  lockNextStaleAssignment(): Promise<never> {
    throw new Error('lockNextStaleAssignment is not used in these unit tests.');
  }
}

class FakeOrdersPort implements IOrdersPort {
  view: DeliverableFulfillmentView | null = deliverable();
  /** Job creation never asks who owns the order — only the tracking path does. */
  customerUserId: string | null = null;
  async getDeliverableFulfillment(): Promise<DeliverableFulfillmentView | null> {
    return this.view;
  }
  async getOrderCustomerUserId(): Promise<string | null> {
    return this.customerUserId;
  }
}

class FakePharmacyPort implements IPharmacyPort {
  branch: BranchPickupView | null = {
    branchId: 'branch-1',
    pharmacyId: 'pharmacy-1',
    lat: 9.03,
    lng: 38.74,
    addressLine: 'Bole Branch, Africa Ave, Bole, Addis Ababa',
  };
  async getBranchPickup(): Promise<BranchPickupView | null> {
    return this.branch;
  }
}

class FakeCatalogPort implements ICatalogPort {
  coldChain = new Set<string>();
  readonly asked: string[][] = [];
  async findColdChainProductIds(ids: string[]): Promise<string[]> {
    this.asked.push(ids);
    return ids.filter((id) => this.coldChain.has(id));
  }
}

/**
 * A routing provider that answers a fixed distance, or refuses.
 *
 * Fixed rather than computed, because what these tests assert is that the job records *whatever
 * the port said* — not that a particular pair of coordinates is 1200 metres apart, which is
 * `HaversineRoutingAdapter`'s business and is tested where that lives.
 */
class FakeRoutingPort implements IRoutingPort {
  distanceMeters: number | null = 1_200;
  throws = false;
  calls = 0;

  async route(request: RouteRequest): Promise<RouteResult | null> {
    void request;
    this.calls += 1;
    if (this.throws) {
      throw new Error('routing provider unreachable');
    }
    return this.distanceMeters === null
      ? null
      : { distanceMeters: this.distanceMeters, durationSeconds: 300 };
  }
}

const uow: IUnitOfWork = { run: (work) => work('tx') };

function deliverable(
  overrides: Partial<DeliverableFulfillmentView> = {},
): DeliverableFulfillmentView {
  return {
    fulfillmentId: FULFILLMENT,
    orderId: 'order-1',
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    status: 'READY',
    isReadyForDelivery: true,
    deliveryJobId: null,
    isCod: false,
    orderTotal: 24_500,
    deliveryFee: 0,
    currency: 'ETB',
    dropoff: { lat: 8.98, lng: 38.79, line1: 'Kazanchis, Bldg 4', city: 'Addis Ababa' },
    lines: [
      { catalogProductId: 'p1', name: 'Amoxicillin 500mg', quantity: 2 },
      { catalogProductId: 'p2', name: 'Insulin Glargine', quantity: 1 },
    ],
    ...overrides,
  };
}

function harness() {
  const jobs = new FakeDeliveryJobRepository();
  const orders = new FakeOrdersPort();
  const pharmacies = new FakePharmacyPort();
  const catalog = new FakeCatalogPort();
  const routing = new FakeRoutingPort();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const outbox = { write: jest.fn().mockResolvedValue(undefined) };

  return {
    jobs,
    orders,
    pharmacies,
    catalog,
    routing,
    audit,
    outbox,
    command: new CreateDeliveryJobCommand(
      jobs,
      orders,
      pharmacies,
      catalog,
      routing,
      uow,
      audit as unknown as AuditService,
      outbox as unknown as OutboxService,
    ),
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  return undefined;
}

describe('CreateDeliveryJobCommand — creation', () => {
  it('creates a job in CREATED from a ready fulfillment', async () => {
    const h = harness();

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.replay).toBe(false);
    expect(result.job).toMatchObject({
      orderId: 'order-1',
      fulfillmentId: FULFILLMENT,
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
      status: DeliveryJobStatus.CREATED,
      assignedDriverId: null,
      pickedUpAt: null,
      deliveredAt: null,
    });
    expect(h.jobs.jobs.size).toBe(1);
  });

  it('takes only a fulfillmentId — every other fact is resolved from its owning module', async () => {
    const h = harness();
    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    // Nothing on the job came from the caller.
    expect(result.job.pharmacyId).toBe('pharmacy-1');
    expect(result.job.dropoffAddress).toContain('Kazanchis');
  });

  it('requires a fulfillmentId', async () => {
    const h = harness();
    expect(await codeOf(() => h.command.execute({ fulfillmentId: '  ' }))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('audits the creation and emits JobCreated in the same transaction', async () => {
    const h = harness();
    const result = await h.command.execute({ fulfillmentId: FULFILLMENT, actorUserId: null });

    expect(h.audit.record).toHaveBeenCalledTimes(1);
    expect(h.audit.record.mock.calls[0][0]).toMatchObject({
      action: 'DELIVERY_JOB_CREATED',
      resourceType: 'DeliveryJob',
      resourceId: result.job.id,
      actorUserId: null,
    });
    // The `tx` handle is passed to both, so neither can commit without the insert.
    expect(h.audit.record.mock.calls[0][1]).toBe('tx');

    expect(h.outbox.write).toHaveBeenCalledTimes(1);
    expect(h.outbox.write.mock.calls[0][0]).toMatchObject({
      type: DeliveryEventType.JobCreated,
      aggregateType: 'DeliveryJob',
      aggregateId: result.job.id,
      payload: { jobId: result.job.id, orderId: 'order-1', fulfillmentId: FULFILLMENT },
    });
    expect(h.outbox.write.mock.calls[0][1]).toBe('tx');
  });
});

describe('CreateDeliveryJobCommand — BRULE-27 eligibility', () => {
  it.each(['PENDING', 'ACCEPTED', 'PREPARING', 'DISPATCHED', 'DELIVERED', 'CANCELLED'])(
    'refuses a fulfillment in %s',
    async (status) => {
      const h = harness();
      h.orders.view = deliverable({ status, isReadyForDelivery: false });

      expect(await codeOf(() => h.command.execute({ fulfillmentId: FULFILLMENT }))).toBe(
        ErrorCode.FULFILLMENT_NOT_DELIVERABLE,
      );
      expect(h.jobs.jobs.size).toBe(0);
    },
  );

  it('refuses a fulfillment that does not exist, without leaking the difference', async () => {
    const h = harness();
    h.orders.view = null;

    expect(await codeOf(() => h.command.execute({ fulfillmentId: FULFILLMENT }))).toBe(
      ErrorCode.FULFILLMENT_NOT_DELIVERABLE,
    );
  });

  it('writes nothing at all when refused', async () => {
    const h = harness();
    h.orders.view = deliverable({ status: 'PREPARING', isReadyForDelivery: false });

    await codeOf(() => h.command.execute({ fulfillmentId: FULFILLMENT }));

    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.outbox.write).not.toHaveBeenCalled();
  });
});

describe('CreateDeliveryJobCommand — snapshots', () => {
  it('snapshots the pickup from Module 04 branch data', async () => {
    const h = harness();
    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job.pickupPoint).toMatchObject({ lat: 9.03, lng: 38.74 });
    expect(job.pickupAddress).toBe('Bole Branch, Africa Ave, Bole, Addis Ababa');
  });

  it('creates a job with no pickup point when the branch is gone, rather than refusing', async () => {
    const h = harness();
    h.pharmacies.branch = null;

    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job.pickupPoint).toBeNull();
    expect(job.pickupAddress).toBeNull();
    expect(job.status).toBe(DeliveryJobStatus.CREATED);
  });

  it("snapshots the dropoff from the order's frozen address, not a live lookup", async () => {
    const h = harness();
    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job.dropoffPoint).toMatchObject({ lat: 8.98, lng: 38.79 });
    expect(job.dropoffAddress).toBe('Kazanchis, Bldg 4, Addis Ababa');
  });

  it('handles an order with no address snapshot', async () => {
    const h = harness();
    h.orders.view = deliverable({ dropoff: null });

    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job.dropoffPoint).toBeNull();
    expect(job.dropoffAddress).toBeNull();
  });

  it('snapshots the item summary, and nothing beyond it', async () => {
    const h = harness();
    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job.items).toEqual([
      { catalogProductId: 'p1', name: 'Amoxicillin 500mg', quantity: 2 },
      { catalogProductId: 'p2', name: 'Insulin Glargine', quantity: 1 },
    ]);
    // No price, no Rx flag, no prescription reference reaches the driver's manifest.
    for (const item of job.items) {
      expect(Object.keys(item).sort()).toEqual(['catalogProductId', 'name', 'quantity']);
    }
  });
});

describe('CreateDeliveryJobCommand — cold chain (BRULE-30)', () => {
  it('is false when no line requires refrigeration', async () => {
    const h = harness();
    expect((await h.command.execute({ fulfillmentId: FULFILLMENT })).job.isColdChain).toBe(false);
  });

  it('is true when any single line does — there is no partly-refrigerated bag', async () => {
    const h = harness();
    h.catalog.coldChain.add('p2');

    expect((await h.command.execute({ fulfillmentId: FULFILLMENT })).job.isColdChain).toBe(true);
  });

  it('asks the catalogue once, with de-duplicated product ids', async () => {
    const h = harness();
    h.orders.view = deliverable({
      lines: [
        { catalogProductId: 'p1', name: 'A', quantity: 1 },
        { catalogProductId: 'p1', name: 'A', quantity: 2 },
      ],
    });

    await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(h.catalog.asked).toEqual([['p1']]);
  });

  it('does not query the catalogue for a fulfillment with no lines', async () => {
    const h = harness();
    h.orders.view = deliverable({ lines: [] });

    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(h.catalog.asked).toEqual([]);
    expect(job.isColdChain).toBe(false);
  });
});

describe('CreateDeliveryJobCommand — COD', () => {
  it('carries the flag and the order total for a COD order', async () => {
    const h = harness();
    h.orders.view = deliverable({ isCod: true, orderTotal: 24_500 });

    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job).toMatchObject({ isCod: true, codAmount: 24_500 });
  });

  it('records no amount for a prepaid order — nothing is left to collect', async () => {
    const h = harness();
    h.orders.view = deliverable({ isCod: false, orderTotal: 24_500 });

    const { job } = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(job).toMatchObject({ isCod: false, codAmount: null });
  });

  it('refuses a COD order whose total is zero rather than sending a driver to collect nothing', async () => {
    const h = harness();
    h.orders.view = deliverable({ isCod: true, orderTotal: 0 });

    expect(await codeOf(() => h.command.execute({ fulfillmentId: FULFILLMENT }))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });
});

describe('CreateDeliveryJobCommand — idempotency', () => {
  it('replays the committed job on a second call', async () => {
    const h = harness();
    const first = await h.command.execute({ fulfillmentId: FULFILLMENT });
    const second = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(h.jobs.jobs.size).toBe(1);
  });

  it('does no cross-module reading at all on a replay', async () => {
    const h = harness();
    await h.command.execute({ fulfillmentId: FULFILLMENT });
    const asked = h.catalog.asked.length;

    await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(h.catalog.asked.length).toBe(asked);
    expect(h.audit.record).toHaveBeenCalledTimes(1);
    expect(h.outbox.write).toHaveBeenCalledTimes(1);
  });

  it('converges on one job when a competing writer wins the race mid-create', async () => {
    const h = harness();
    // A second creator commits between this one's in-transaction re-check and its insert — the
    // exact window the unique index exists to close.
    h.jobs.onCreate = async () => {
      h.jobs.jobs.set('winner', {
        ...(await buildWinner(h)),
      });
    };

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.replay).toBe(true);
    expect(result.job.id).toBe('winner');
    expect(h.jobs.jobs.size).toBe(1);
  });

  it('converges on one job when three creators run concurrently', async () => {
    const h = harness();

    const results = await Promise.all([
      h.command.execute({ fulfillmentId: FULFILLMENT }),
      h.command.execute({ fulfillmentId: FULFILLMENT }),
      h.command.execute({ fulfillmentId: FULFILLMENT }),
    ]);

    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(h.jobs.jobs.size).toBe(1);
  });
});

/** A job for the competing writer to commit, shaped like the one under test. */
async function buildWinner(h: ReturnType<typeof harness>): Promise<DeliveryJobProps> {
  const view = h.orders.view as DeliverableFulfillmentView;
  return {
    id: 'winner',
    orderId: view.orderId,
    fulfillmentId: view.fulfillmentId,
    pharmacyId: view.pharmacyId,
    branchId: view.branchId,
    pickupPoint: null,
    pickupAddress: null,
    dropoffPoint: null,
    dropoffAddress: null,
    items: [],
    isColdChain: false,
    isCod: false,
    codAmount: null,
    deliveryFee: 0,
    distanceMeters: null,
    status: DeliveryJobStatus.CREATED,
    assignedDriverId: null,
    pickedUpAt: null,
    deliveredAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('CreateDeliveryJobCommand — the delivery-fee snapshot (F-FEE-01, §12)', () => {
  it('copies the charged fee from Module 06 rather than recalculating it', async () => {
    const h = harness();
    h.orders.view = deliverable({ deliveryFee: 4_250 });

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.job.deliveryFee).toBe(4_250);
  });

  it('records the distance the job was dispatched against, from IRoutingPort', async () => {
    const h = harness();
    h.routing.distanceMeters = 6_100;

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.job.distanceMeters).toBe(6_100);
    expect(h.routing.calls).toBe(1);
  });

  /**
   * The point of the whole snapshot decision. An operator who raises the rate card between
   * checkout and dispatch must not change what a customer already agreed to pay, and the only way
   * to guarantee that is for this command never to run the calculation at all.
   */
  it('is unaffected by the rate card, because it never runs the rate card', async () => {
    const h = harness();
    h.orders.view = deliverable({ deliveryFee: 1_500 });

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.job.deliveryFee).toBe(1_500);
  });

  it('still creates the job when the routing provider cannot answer', async () => {
    const h = harness();
    h.routing.distanceMeters = null;

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.replay).toBe(false);
    expect(result.job.distanceMeters).toBeNull();
  });

  it('still creates the job when the routing provider throws', async () => {
    const h = harness();
    h.routing.throws = true;

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(result.job.distanceMeters).toBeNull();
  });

  it('does not ask for a route when a coordinate is missing', async () => {
    const h = harness();
    h.orders.view = deliverable({ dropoff: { lat: null, lng: null, line1: 'x', city: 'y' } });

    const result = await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(h.routing.calls).toBe(0);
    expect(result.job.distanceMeters).toBeNull();
  });

  it('records both snapshots in the audit trail', async () => {
    const h = harness();
    h.orders.view = deliverable({ deliveryFee: 3_300 });
    h.routing.distanceMeters = 2_400;

    await h.command.execute({ fulfillmentId: FULFILLMENT });

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ deliveryFee: 3_300, distanceMeters: 2_400 }),
      }),
      'tx',
    );
  });

  /**
   * §11's event contract, unchanged. A delivery fee is a Module 06 fact and a Module 07 concern;
   * broadcasting it on the job-created event would make it a third module's input by accident.
   */
  it('keeps the fee out of the JobCreated event', async () => {
    const h = harness();
    h.orders.view = deliverable({ deliveryFee: 3_300 });

    await h.command.execute({ fulfillmentId: FULFILLMENT });

    const [event] = h.outbox.write.mock.calls[0] as [{ payload: Record<string, unknown> }];
    expect(event.payload).not.toHaveProperty('deliveryFee');
    expect(event.payload).not.toHaveProperty('distanceMeters');
  });
});
