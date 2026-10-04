import { ErrorCode } from '../../../../shared/errors/error-codes';
import { ApiException } from '../../../../shared/errors/api-exception';
import { DeliveryJobStatus } from '../enums';
import { DeliveryStatusPolicy } from './delivery-status-policy';

const ALL_STATUSES = Object.values(DeliveryJobStatus);

/** The approved F-STS-01 table, written out independently of the implementation. */
const EXPECTED: Record<DeliveryJobStatus, DeliveryJobStatus[]> = {
  [DeliveryJobStatus.CREATED]: [DeliveryJobStatus.OFFERED, DeliveryJobStatus.CANCELLED],
  [DeliveryJobStatus.OFFERED]: [DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.CANCELLED],
  [DeliveryJobStatus.ASSIGNED]: [
    DeliveryJobStatus.ARRIVED_PICKUP,
    DeliveryJobStatus.REASSIGNING,
    DeliveryJobStatus.CANCELLED,
  ],
  [DeliveryJobStatus.ARRIVED_PICKUP]: [
    DeliveryJobStatus.PICKED_UP,
    DeliveryJobStatus.REASSIGNING,
    DeliveryJobStatus.CANCELLED,
  ],
  [DeliveryJobStatus.PICKED_UP]: [DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.FAILED],
  [DeliveryJobStatus.EN_ROUTE]: [DeliveryJobStatus.ARRIVED_DROPOFF, DeliveryJobStatus.FAILED],
  [DeliveryJobStatus.ARRIVED_DROPOFF]: [DeliveryJobStatus.DELIVERED, DeliveryJobStatus.FAILED],
  [DeliveryJobStatus.DELIVERED]: [DeliveryJobStatus.COMPLETED],
  [DeliveryJobStatus.COMPLETED]: [],
  [DeliveryJobStatus.REASSIGNING]: [DeliveryJobStatus.OFFERED, DeliveryJobStatus.CANCELLED],
  [DeliveryJobStatus.CANCELLED]: [],
  [DeliveryJobStatus.FAILED]: [],
};

describe('DeliveryStatusPolicy', () => {
  it('covers every schema status — a new enum value cannot be silently unhandled', () => {
    expect(ALL_STATUSES.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  describe('the happy path, transition by transition', () => {
    const HAPPY_PATH: [DeliveryJobStatus, DeliveryJobStatus][] = [
      [DeliveryJobStatus.CREATED, DeliveryJobStatus.OFFERED],
      [DeliveryJobStatus.OFFERED, DeliveryJobStatus.ASSIGNED],
      [DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.ARRIVED_PICKUP],
      [DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP],
      [DeliveryJobStatus.PICKED_UP, DeliveryJobStatus.EN_ROUTE],
      [DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.ARRIVED_DROPOFF],
      [DeliveryJobStatus.ARRIVED_DROPOFF, DeliveryJobStatus.DELIVERED],
      [DeliveryJobStatus.DELIVERED, DeliveryJobStatus.COMPLETED],
    ];

    it.each(HAPPY_PATH)('allows %s -> %s', (from, to) => {
      expect(DeliveryStatusPolicy.isLegalTransition(from, to)).toBe(true);
      expect(() => DeliveryStatusPolicy.assertValidTransition(from, to)).not.toThrow();
    });
  });

  describe('every state permits exactly the approved set and nothing else', () => {
    it.each(ALL_STATUSES)('%s', (from) => {
      expect(DeliveryStatusPolicy.nextStates(from).sort()).toEqual(EXPECTED[from].sort());

      for (const to of ALL_STATUSES) {
        expect(DeliveryStatusPolicy.isLegalTransition(from, to)).toBe(
          EXPECTED[from].includes(to),
        );
      }
    });
  });

  it('has no self-loops — re-sending a status is not a transition', () => {
    for (const status of ALL_STATUSES) {
      expect(DeliveryStatusPolicy.isLegalTransition(status, status)).toBe(false);
    }
  });

  it('throws INVALID_DELIVERY_STATE_TRANSITION naming both ends', () => {
    let caught: ApiException | undefined;
    try {
      DeliveryStatusPolicy.assertValidTransition(
        DeliveryJobStatus.CREATED,
        DeliveryJobStatus.DELIVERED,
      );
    } catch (err) {
      caught = err as ApiException;
    }
    expect(caught?.code).toBe(ErrorCode.INVALID_DELIVERY_STATE_TRANSITION);
    expect(caught?.details).toMatchObject({
      from: DeliveryJobStatus.CREATED,
      to: DeliveryJobStatus.DELIVERED,
      aggregate: 'deliveryJob',
    });
  });

  describe('terminal states', () => {
    const TERMINAL: DeliveryJobStatus[] = [
      DeliveryJobStatus.COMPLETED,
      DeliveryJobStatus.CANCELLED,
      DeliveryJobStatus.FAILED,
    ];

    it.each(TERMINAL)('%s is terminal and admits no transition at all', (status) => {
      expect(DeliveryStatusPolicy.isTerminal(status)).toBe(true);
      for (const to of ALL_STATUSES) {
        expect(DeliveryStatusPolicy.isLegalTransition(status, to)).toBe(false);
      }
    });

    it.each(ALL_STATUSES.filter((s) => !TERMINAL.includes(s)))(
      '%s is not terminal',
      (status) => {
        expect(DeliveryStatusPolicy.isTerminal(status)).toBe(false);
      },
    );
  });

  describe('cancellation stops at pickup', () => {
    const CANCELLABLE: DeliveryJobStatus[] = [
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.REASSIGNING,
    ];

    it.each(CANCELLABLE)('%s may still be cancelled — nobody is carrying the goods', (status) => {
      expect(DeliveryStatusPolicy.isCancellable(status)).toBe(true);
      expect(DeliveryStatusPolicy.isLegalTransition(status, DeliveryJobStatus.CANCELLED)).toBe(
        true,
      );
    });

    // Once the driver holds the medicines, "cancelled" would contradict the world: the items are
    // in a bag and have to end up somewhere. That path is FAILED, which carries a return
    // obligation.
    it.each([
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
    ])('%s may not be cancelled', (status) => {
      expect(DeliveryStatusPolicy.isCancellable(status)).toBe(false);
      expect(DeliveryStatusPolicy.isLegalTransition(status, DeliveryJobStatus.CANCELLED)).toBe(
        false,
      );
    });
  });

  describe('reassignment is pre-pickup only (BRULE-19, F-JOB-05)', () => {
    it.each([DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.ARRIVED_PICKUP])(
      '%s may go back into dispatch',
      (status) => {
        expect(DeliveryStatusPolicy.isLegalTransition(status, DeliveryJobStatus.REASSIGNING)).toBe(
          true,
        );
      },
    );

    it.each(ALL_STATUSES.filter(
      (s) => s !== DeliveryJobStatus.ASSIGNED && s !== DeliveryJobStatus.ARRIVED_PICKUP,
    ))('%s may not', (status) => {
      expect(DeliveryStatusPolicy.isLegalTransition(status, DeliveryJobStatus.REASSIGNING)).toBe(
        false,
      );
    });

    it('re-enters dispatch at OFFERED rather than jumping straight to a driver', () => {
      expect(DeliveryStatusPolicy.nextStates(DeliveryJobStatus.REASSIGNING).sort()).toEqual(
        [DeliveryJobStatus.CANCELLED, DeliveryJobStatus.OFFERED].sort(),
      );
    });
  });

  describe('failure is a dropoff-side outcome', () => {
    it.each([
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ])('%s may fail', (status) => {
      expect(DeliveryStatusPolicy.isLegalTransition(status, DeliveryJobStatus.FAILED)).toBe(true);
    });

    // §6.5/§11.5: dispatch exhaustion escalates (NO_DRIVER_AVAILABLE) and the job stays
    // offerable. A job that auto-failed after N rounds would strand an order a human could
    // still have dispatched.
    it.each([
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.REASSIGNING,
    ])('%s may not fail — dispatch exhaustion escalates, it does not terminate', (status) => {
      expect(DeliveryStatusPolicy.isLegalTransition(status, DeliveryJobStatus.FAILED)).toBe(false);
    });

    it('a delivered job cannot be failed after the fact', () => {
      expect(
        DeliveryStatusPolicy.isLegalTransition(
          DeliveryJobStatus.DELIVERED,
          DeliveryJobStatus.FAILED,
        ),
      ).toBe(false);
    });
  });

  it('never skips a step on the forward path', () => {
    expect(
      DeliveryStatusPolicy.isLegalTransition(DeliveryJobStatus.ASSIGNED, DeliveryJobStatus.PICKED_UP),
    ).toBe(false);
    expect(
      DeliveryStatusPolicy.isLegalTransition(DeliveryJobStatus.PICKED_UP, DeliveryJobStatus.DELIVERED),
    ).toBe(false);
    expect(
      DeliveryStatusPolicy.isLegalTransition(DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.COMPLETED),
    ).toBe(false);
  });

  it('never runs backwards', () => {
    const FORWARD: DeliveryJobStatus[] = [
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
      DeliveryJobStatus.COMPLETED,
    ];
    for (let i = 0; i < FORWARD.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        expect(DeliveryStatusPolicy.isLegalTransition(FORWARD[i], FORWARD[j])).toBe(false);
      }
    }
  });

  describe('requiresAssignedDriver', () => {
    it.each([
      DeliveryJobStatus.ASSIGNED,
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
      DeliveryJobStatus.DELIVERED,
      DeliveryJobStatus.COMPLETED,
    ])('%s requires a driver', (status) => {
      expect(DeliveryStatusPolicy.requiresAssignedDriver(status)).toBe(true);
    });

    it.each([
      DeliveryJobStatus.CREATED,
      DeliveryJobStatus.OFFERED,
      DeliveryJobStatus.REASSIGNING,
      DeliveryJobStatus.CANCELLED,
      DeliveryJobStatus.FAILED,
    ])('%s does not', (status) => {
      expect(DeliveryStatusPolicy.requiresAssignedDriver(status)).toBe(false);
    });
  });
});
