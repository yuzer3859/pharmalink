import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { DeliveryJobStatus } from '../enums';
import { GeoPoint } from '../value-objects/geo-point.vo';
import { DeliveryJob, NewDeliveryJobInput } from './delivery-job.entity';

const DRIVER = 'driver-profile-1';
const AT = new Date('2026-09-20T08:00:00.000Z');

function newJob(overrides: Partial<NewDeliveryJobInput> = {}): DeliveryJob {
  return DeliveryJob.create({
    id: 'job-1',
    orderId: 'order-1',
    fulfillmentId: 'fulfillment-1',
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    now: AT,
    ...overrides,
  });
}

/** Drives a job to `status` through legal transitions only — never by constructing it there. */
function jobAt(status: DeliveryJobStatus, overrides: Partial<NewDeliveryJobInput> = {}): DeliveryJob {
  let job = newJob(overrides);
  const path: DeliveryJobStatus[] = [
    DeliveryJobStatus.OFFERED,
    DeliveryJobStatus.ASSIGNED,
    DeliveryJobStatus.ARRIVED_PICKUP,
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.EN_ROUTE,
    DeliveryJobStatus.ARRIVED_DROPOFF,
    DeliveryJobStatus.DELIVERED,
    DeliveryJobStatus.COMPLETED,
  ];
  for (const step of path) {
    if (job.status === status) {
      return job;
    }
    job = job.transitionTo(
      step,
      step === DeliveryJobStatus.ASSIGNED ? { assignedDriverId: DRIVER } : {},
    );
  }
  return job;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  return undefined;
}

describe('DeliveryJob — creation', () => {
  it('starts at CREATED with no driver and no physical timestamps', () => {
    const props = newJob().toProps();

    expect(props).toMatchObject({
      status: DeliveryJobStatus.CREATED,
      assignedDriverId: null,
      pickedUpAt: null,
      deliveredAt: null,
      isColdChain: false,
      isCod: false,
      codAmount: null,
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it('does not accept a status — a job cannot be constructed mid-lifecycle', () => {
    const input = { status: DeliveryJobStatus.DELIVERED } as unknown as NewDeliveryJobInput;
    expect(newJob(input).status).toBe(DeliveryJobStatus.CREATED);
  });

  it('keeps the cross-context references it was given', () => {
    expect(newJob().toProps()).toMatchObject({
      orderId: 'order-1',
      fulfillmentId: 'fulfillment-1',
      pharmacyId: 'pharmacy-1',
      branchId: 'branch-1',
    });
  });

  it.each(['id', 'orderId', 'fulfillmentId', 'pharmacyId', 'branchId'])(
    'requires %s',
    (field) => {
      expect(codeOf(() => newJob({ [field]: '  ' } as Partial<NewDeliveryJobInput>))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    },
  );

  it('snapshots pickup and dropoff', () => {
    const props = newJob({
      pickupPoint: GeoPoint.of(9.03, 38.74),
      pickupAddress: '  Bole Branch, Addis Ababa  ',
      dropoffPoint: GeoPoint.of(8.98, 38.79),
      dropoffAddress: 'Kazanchis',
    }).toProps();

    expect(props.pickupPoint).toEqual(GeoPoint.of(9.03, 38.74));
    expect(props.pickupAddress).toBe('Bole Branch, Addis Ababa');
    expect(props.dropoffPoint).toEqual(GeoPoint.of(8.98, 38.79));
    expect(props.dropoffAddress).toBe('Kazanchis');
  });

  it('allows a job with no coordinates yet — a point is not required to create the job', () => {
    expect(newJob().toProps()).toMatchObject({ pickupPoint: null, dropoffPoint: null });
  });

  it('returns a defensive copy of its items', () => {
    const job = newJob({
      items: [{ catalogProductId: 'p1', name: 'Amoxicillin 500mg', quantity: 2 }],
    });
    const first = job.toProps();
    first.items[0].quantity = 99;

    expect(job.toProps().items[0].quantity).toBe(2);
  });

  it('rejects a non-positive or fractional item quantity', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(
        codeOf(() => newJob({ items: [{ catalogProductId: 'p1', name: 'X', quantity }] })),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });
});

describe('DeliveryJob — cold chain and COD', () => {
  it('carries the cold-chain flag (BRULE-30)', () => {
    expect(newJob({ isColdChain: true }).toProps().isColdChain).toBe(true);
  });

  it('accepts a COD job with a positive integer amount in minor units', () => {
    expect(newJob({ isCod: true, codAmount: 24_500 }).toProps()).toMatchObject({
      isCod: true,
      codAmount: 24_500,
    });
  });

  // A COD job with no amount sends a driver to collect an unknown sum.
  it.each([null, undefined, 0, -1, 100.5])('rejects a COD job with amount %p', (codAmount) => {
    expect(
      codeOf(() => newJob({ isCod: true, codAmount: codAmount as number | null | undefined })),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  // An amount on a non-COD job invites a driver to collect one that was already paid online.
  it('rejects an amount on a non-COD job', () => {
    expect(codeOf(() => newJob({ isCod: false, codAmount: 24_500 }))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('keeps COD and cold-chain intact across the whole lifecycle', () => {
    const props = jobAt(DeliveryJobStatus.COMPLETED, {
      isCod: true,
      codAmount: 24_500,
      isColdChain: true,
    }).toProps();

    expect(props).toMatchObject({
      isCod: true,
      codAmount: 24_500,
      isColdChain: true,
      status: DeliveryJobStatus.COMPLETED,
    });
  });
});

describe('DeliveryJob — the happy path', () => {
  it('walks CREATED to COMPLETED', () => {
    const job = jobAt(DeliveryJobStatus.COMPLETED);

    expect(job.status).toBe(DeliveryJobStatus.COMPLETED);
    expect(job.isTerminal).toBe(true);
    expect(job.assignedDriverId).toBe(DRIVER);
  });

  it('does not mutate the receiver — a transition returns a new job', () => {
    const created = newJob();
    const offered = created.transitionTo(DeliveryJobStatus.OFFERED);

    expect(created.status).toBe(DeliveryJobStatus.CREATED);
    expect(offered.status).toBe(DeliveryJobStatus.OFFERED);
    expect(offered).not.toBe(created);
  });

  it('leaves the job untouched when a transition is refused', () => {
    const created = newJob();
    expect(() => created.transitionTo(DeliveryJobStatus.DELIVERED)).toThrow();
    expect(created.status).toBe(DeliveryJobStatus.CREATED);
  });

  it('stamps pickedUpAt and deliveredAt with the transitions that cause them', () => {
    const pickedUpAt = new Date('2026-09-20T09:00:00.000Z');
    const deliveredAt = new Date('2026-09-20T09:40:00.000Z');

    let job = jobAt(DeliveryJobStatus.ARRIVED_PICKUP);
    expect(job.toProps().pickedUpAt).toBeNull();

    job = job.transitionTo(DeliveryJobStatus.PICKED_UP, { now: pickedUpAt });
    expect(job.toProps()).toMatchObject({ pickedUpAt, deliveredAt: null, updatedAt: pickedUpAt });

    job = job
      .transitionTo(DeliveryJobStatus.EN_ROUTE)
      .transitionTo(DeliveryJobStatus.ARRIVED_DROPOFF)
      .transitionTo(DeliveryJobStatus.DELIVERED, { now: deliveredAt });

    expect(job.toProps()).toMatchObject({ pickedUpAt, deliveredAt });
  });
});

describe('DeliveryJob — assignment', () => {
  it('requires a driver to reach ASSIGNED', () => {
    const offered = newJob().transitionTo(DeliveryJobStatus.OFFERED);
    expect(codeOf(() => offered.transitionTo(DeliveryJobStatus.ASSIGNED))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('records the driver on assignment', () => {
    expect(jobAt(DeliveryJobStatus.ASSIGNED).assignedDriverId).toBe(DRIVER);
  });

  it('refuses a driver on any transition other than assignment', () => {
    const created = newJob();
    expect(
      codeOf(() =>
        created.transitionTo(DeliveryJobStatus.OFFERED, { assignedDriverId: 'driver-2' }),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('keeps the driver for the rest of the forward path', () => {
    for (const status of [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
      DeliveryJobStatus.COMPLETED,
    ]) {
      expect(jobAt(status).assignedDriverId).toBe(DRIVER);
    }
  });
});

describe('DeliveryJob — branches', () => {
  it.each([
    DeliveryJobStatus.CREATED,
    DeliveryJobStatus.OFFERED,
    DeliveryJobStatus.ASSIGNED,
    DeliveryJobStatus.ARRIVED_PICKUP,
  ])('cancels from %s', (status) => {
    const cancelled = jobAt(status).transitionTo(DeliveryJobStatus.CANCELLED);

    expect(cancelled.status).toBe(DeliveryJobStatus.CANCELLED);
    expect(cancelled.isTerminal).toBe(true);
  });

  it('keeps the driver on a cancelled job — the trail is what a dispute needs', () => {
    const cancelled = jobAt(DeliveryJobStatus.ASSIGNED).transitionTo(DeliveryJobStatus.CANCELLED);
    expect(cancelled.assignedDriverId).toBe(DRIVER);
  });

  it.each([
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.EN_ROUTE,
    DeliveryJobStatus.ARRIVED_DROPOFF,
  ])('refuses cancellation from %s — the goods are with the driver', (status) => {
    const job = jobAt(status);
    expect(job.isCancellable).toBe(false);
    expect(codeOf(() => job.transitionTo(DeliveryJobStatus.CANCELLED))).toBe(
      ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
    );
  });

  it.each([
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.EN_ROUTE,
    DeliveryJobStatus.ARRIVED_DROPOFF,
  ])('fails from %s', (status) => {
    const failed = jobAt(status).transitionTo(DeliveryJobStatus.FAILED);

    expect(failed.status).toBe(DeliveryJobStatus.FAILED);
    expect(failed.isTerminal).toBe(true);
    // The driver stays attached: a failed delivery still has goods to return.
    expect(failed.assignedDriverId).toBe(DRIVER);
  });

  it('releases the driver slot on REASSIGNING (BRULE-28)', () => {
    const reassigning = jobAt(DeliveryJobStatus.ASSIGNED).transitionTo(
      DeliveryJobStatus.REASSIGNING,
    );

    expect(reassigning.status).toBe(DeliveryJobStatus.REASSIGNING);
    expect(reassigning.assignedDriverId).toBeNull();
  });

  it('re-offers after reassignment and can take a different driver', () => {
    const reassigned = jobAt(DeliveryJobStatus.ARRIVED_PICKUP)
      .transitionTo(DeliveryJobStatus.REASSIGNING)
      .transitionTo(DeliveryJobStatus.OFFERED)
      .transitionTo(DeliveryJobStatus.ASSIGNED, { assignedDriverId: 'driver-profile-2' });

    expect(reassigned.assignedDriverId).toBe('driver-profile-2');
  });

  it('refuses reassignment once the goods are picked up (BRULE-19, F-JOB-05)', () => {
    expect(
      codeOf(() =>
        jobAt(DeliveryJobStatus.PICKED_UP).transitionTo(DeliveryJobStatus.REASSIGNING),
      ),
    ).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
  });
});

describe('DeliveryJob — terminal-state protection', () => {
  const terminals: [string, () => DeliveryJob][] = [
    ['COMPLETED', () => jobAt(DeliveryJobStatus.COMPLETED)],
    ['CANCELLED', () => newJob().transitionTo(DeliveryJobStatus.CANCELLED)],
    [
      'FAILED',
      () => jobAt(DeliveryJobStatus.PICKED_UP).transitionTo(DeliveryJobStatus.FAILED),
    ],
  ];

  it.each(terminals)('%s admits no further transition', (_name, build) => {
    const job = build();
    expect(job.isTerminal).toBe(true);

    for (const to of Object.values(DeliveryJobStatus)) {
      expect(codeOf(() => job.transitionTo(to))).toBe(
        ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      );
    }
  });
});

describe('DeliveryJob — rehydration', () => {
  it('round-trips a persisted job', () => {
    const props = jobAt(DeliveryJobStatus.EN_ROUTE, { isCod: true, codAmount: 1_000 }).toProps();
    expect(DeliveryJob.rehydrate(props).toProps()).toEqual(props);
  });

  it('continues the lifecycle from where the row left off', () => {
    const props = jobAt(DeliveryJobStatus.EN_ROUTE).toProps();
    const resumed = DeliveryJob.rehydrate(props).transitionTo(DeliveryJobStatus.ARRIVED_DROPOFF);

    expect(resumed.status).toBe(DeliveryJobStatus.ARRIVED_DROPOFF);
  });

  // A row that has drifted is caught on read rather than propagated into a dispatch.
  it('rejects a driver-carrying status with no driver', () => {
    const props = { ...jobAt(DeliveryJobStatus.PICKED_UP).toProps(), assignedDriverId: null };
    expect(codeOf(() => DeliveryJob.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a driver on a job that was never assigned', () => {
    const props = { ...newJob().toProps(), assignedDriverId: DRIVER };
    expect(codeOf(() => DeliveryJob.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a delivery that precedes its own pickup', () => {
    const props = {
      ...jobAt(DeliveryJobStatus.DELIVERED).toProps(),
      pickedUpAt: new Date('2026-09-20T10:00:00.000Z'),
      deliveredAt: new Date('2026-09-20T09:00:00.000Z'),
    };
    expect(codeOf(() => DeliveryJob.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a delivered job with no pickup time', () => {
    const props = { ...jobAt(DeliveryJobStatus.DELIVERED).toProps(), pickedUpAt: null };
    expect(codeOf(() => DeliveryJob.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('rejects a COD row whose amount has gone missing', () => {
    const props = { ...newJob({ isCod: true, codAmount: 500 }).toProps(), codAmount: null };
    expect(codeOf(() => DeliveryJob.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

describe('GeoPoint', () => {
  it('accepts a valid point', () => {
    expect(GeoPoint.of(9.03, 38.74)).toMatchObject({ lat: 9.03, lng: 38.74 });
  });

  it.each([
    [91, 38.74],
    [-91, 38.74],
    [9.03, 181],
    [9.03, -181],
    [Number.NaN, 38.74],
  ])('rejects (%p, %p)', (lat, lng) => {
    expect(codeOf(() => GeoPoint.of(lat, lng))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('does not apply an Ethiopia bounding box — a coordinate is evidence, not a claim', () => {
    expect(() => GeoPoint.of(51.5, -0.12)).not.toThrow();
  });

  it('treats a half-supplied pair as a defect, not as absent', () => {
    expect(codeOf(() => GeoPoint.optional(9.03, null))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(codeOf(() => GeoPoint.optional(null, 38.74))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(GeoPoint.optional(null, null)).toBeNull();
    expect(GeoPoint.optional(9.03, 38.74)).toMatchObject({ lat: 9.03 });
  });
});
