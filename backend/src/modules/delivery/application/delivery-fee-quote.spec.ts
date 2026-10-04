import { IConfigPort } from '../../../shared/config/config.port';
import {
  isValidDeliveryFeeZones,
  parseDeliveryFeeZones,
} from '../../../shared/config/delivery.config';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { ApiException } from '../../../shared/errors/api-exception';
import {
  DeliveryFeePolicy,
  DeliveryFeeSettings,
} from '../domain/services/delivery-fee-policy';
import { Money } from '../domain/value-objects/money.vo';
import {
  DeliveryAddressView,
  IAddressPort,
} from './ports/outbound/address.port';
import { BranchPickupView, IPharmacyPort } from './ports/outbound/pharmacy.port';
import {
  IRoutingPort,
  RouteRequest,
  RouteResult,
} from './ports/outbound/routing.port';
import { QuoteDeliveryFeeQuery } from './queries/quote-delivery-fee.query';
import { resolveDeliveryFeeSettings } from './services/delivery-fee-settings';

const CUSTOMER = 'user-1';
const ADDRESS = 'address-1';
const BRANCH = 'branch-1';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAddressPort implements IAddressPort {
  /** Keyed `addressId|ownerUserId`, so ownership is a real property of the fake, not a check. */
  readonly rows = new Map<string, DeliveryAddressView>();
  readonly asked: Array<{ addressId: string; customerUserId: string }> = [];

  seed(addressId: string, ownerUserId: string, view: Partial<DeliveryAddressView> = {}): void {
    this.rows.set(`${addressId}|${ownerUserId}`, {
      lat: 8.98,
      lng: 38.79,
      line1: 'Kazanchis, Bldg 4',
      city: 'Addis Ababa',
      ...view,
    });
  }

  async getAddress(
    addressId: string,
    customerUserId: string,
  ): Promise<DeliveryAddressView | null> {
    this.asked.push({ addressId, customerUserId });
    return this.rows.get(`${addressId}|${customerUserId}`) ?? null;
  }
}

class FakePharmacyPort implements IPharmacyPort {
  readonly rows = new Map<string, BranchPickupView>();

  seed(branchId: string, view: Partial<BranchPickupView> = {}): void {
    this.rows.set(branchId, {
      branchId,
      pharmacyId: 'pharmacy-1',
      lat: 9.01,
      lng: 38.76,
      addressLine: 'Bole Road 12',
      ...view,
    });
  }

  async getBranchPickup(branchId: string): Promise<BranchPickupView | null> {
    return this.rows.get(branchId) ?? null;
  }
}

class FakeRoutingPort implements IRoutingPort {
  distanceMeters: number | null = 4_200;
  durationSeconds = 690;
  throws = false;
  readonly requests: RouteRequest[] = [];

  async route(request: RouteRequest): Promise<RouteResult | null> {
    this.requests.push(request);
    if (this.throws) {
      throw new Error('routing provider unreachable');
    }
    return this.distanceMeters === null
      ? null
      : { distanceMeters: this.distanceMeters, durationSeconds: this.durationSeconds };
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

function settings(overrides: Partial<DeliveryFeeSettings> = {}): DeliveryFeeSettings {
  return {
    pricingVersion: 'v1',
    base: 0,
    perKm: 0,
    minimum: 0,
    maximum: null,
    roundTo: 1,
    zones: [],
    ...overrides,
  };
}

function harness() {
  const addresses = new FakeAddressPort();
  const pharmacies = new FakePharmacyPort();
  const routing = new FakeRoutingPort();
  const config = new FakeConfig();
  addresses.seed(ADDRESS, CUSTOMER);
  pharmacies.seed(BRANCH);
  return {
    addresses,
    pharmacies,
    routing,
    config,
    query: new QuoteDeliveryFeeQuery(addresses, pharmacies, routing, config),
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

describe('Module 08 — delivery fee calculation and quoting (F-FEE-01, BR-DEL-09)', () => {
  describe('the rate card as shipped', () => {
    it('1. charges nothing, because no fee model has been approved', () => {
      const quote = DeliveryFeePolicy.quote(12_000, settings());

      expect(quote.fee.amountMinor).toBe(0);
      expect(quote.fee.currency).toBe('ETB');
    });

    it('2. reports the distance it was given even when the fee is zero', () => {
      expect(DeliveryFeePolicy.quote(12_000, settings()).distanceMeters).toBe(12_000);
    });
  });

  describe('distance-based pricing', () => {
    it('3. charges base plus the per-kilometre rate over the routed distance', () => {
      const quote = DeliveryFeePolicy.quote(5_000, settings({ base: 2_000, perKm: 1_000 }));

      expect(quote.basis).toBe('DISTANCE');
      expect(quote.baseFee).toBe(2_000);
      expect(quote.distanceFee).toBe(5_000);
      expect(quote.fee.amountMinor).toBe(7_000);
    });

    it('4. prorates a partial kilometre rather than charging a whole one', () => {
      const quote = DeliveryFeePolicy.quote(500, settings({ base: 0, perKm: 1_000 }));

      expect(quote.distanceFee).toBe(500);
    });

    it('5. is exact integer arithmetic — a rate that cannot divide evenly still lands on a santim', () => {
      // 333 santim/km over 1,001 m is 333.333 santim: a float would land on 333.33300000000003.
      const quote = DeliveryFeePolicy.quote(1_001, settings({ perKm: 333 }));

      expect(Number.isInteger(quote.fee.amountMinor)).toBe(true);
      expect(quote.fee.amountMinor).toBe(333);
    });

    it('6. charges zero for a zero distance when only a per-kilometre rate is set', () => {
      expect(DeliveryFeePolicy.quote(0, settings({ perKm: 1_500 })).fee.amountMinor).toBe(0);
    });
  });

  describe('zone-based pricing', () => {
    const zoned = settings({
      base: 2_000,
      perKm: 1_000,
      zones: [
        { id: 'inner', uptoMeters: 3_000, fee: 2_500 },
        { id: 'middle', uptoMeters: 8_000, fee: 4_000 },
      ],
    });

    it('7. charges the matching band flat, replacing the distance formula', () => {
      const quote = DeliveryFeePolicy.quote(2_900, zoned);

      expect(quote.basis).toBe('ZONE');
      expect(quote.zoneId).toBe('inner');
      expect(quote.distanceFee).toBe(0);
      expect(quote.fee.amountMinor).toBe(2_500);
    });

    it('8. treats a band boundary as inside the band', () => {
      expect(DeliveryFeePolicy.quote(3_000, zoned).zoneId).toBe('inner');
      expect(DeliveryFeePolicy.quote(3_001, zoned).zoneId).toBe('middle');
    });

    it('9. picks the nearest matching band, not the first one configured', () => {
      const unordered = settings({
        zones: [
          { id: 'middle', uptoMeters: 8_000, fee: 4_000 },
          { id: 'inner', uptoMeters: 3_000, fee: 2_500 },
        ],
      });

      expect(DeliveryFeePolicy.quote(1_000, unordered).zoneId).toBe('inner');
    });

    it('10. falls through to the distance formula past the furthest band — the no-match rule', () => {
      const quote = DeliveryFeePolicy.quote(12_000, zoned);

      expect(quote.basis).toBe('DISTANCE');
      expect(quote.zoneId).toBeNull();
      expect(quote.fee.amountMinor).toBe(2_000 + 12_000);
    });

    it('11. is deterministic: the same distance and rate card give the same answer every time', () => {
      const first = DeliveryFeePolicy.quote(4_321, zoned);
      const second = DeliveryFeePolicy.quote(4_321, zoned);

      expect(second).toEqual(first);
    });
  });

  describe('rounding, floors and caps', () => {
    it('12. rounds to the configured step', () => {
      // 1,847 santim, rounded to the nearest 100 (whole birr).
      const quote = DeliveryFeePolicy.quote(1_847, settings({ perKm: 1_000, roundTo: 100 }));

      expect(quote.fee.amountMinor).toBe(1_800);
    });

    it('13. rounds half away from zero, the convention PricingCalculator already uses', () => {
      expect(
        DeliveryFeePolicy.quote(1_850, settings({ perKm: 1_000, roundTo: 100 })).fee.amountMinor,
      ).toBe(1_900);
    });

    it('14. applies the floor after rounding, so a minimum is a guarantee', () => {
      const quote = DeliveryFeePolicy.quote(
        100,
        settings({ perKm: 1_000, roundTo: 100, minimum: 2_050 }),
      );

      expect(quote.fee.amountMinor).toBe(2_050);
    });

    it('15. caps a long delivery at the configured maximum', () => {
      const quote = DeliveryFeePolicy.quote(50_000, settings({ perKm: 1_000, maximum: 8_000 }));

      expect(quote.fee.amountMinor).toBe(8_000);
    });

    it('16. lets the cap win over a contradictory floor — a promise beats a preference', () => {
      const quote = DeliveryFeePolicy.quote(
        1_000,
        settings({ minimum: 9_000, maximum: 5_000 }),
      );

      expect(quote.fee.amountMinor).toBe(5_000);
    });

    it('17. still reports the un-rounded components, so the charge can be explained', () => {
      const quote = DeliveryFeePolicy.quote(
        1_847,
        settings({ base: 500, perKm: 1_000, roundTo: 100 }),
      );

      expect(quote.baseFee).toBe(500);
      expect(quote.distanceFee).toBe(1_847);
      expect(quote.fee.amountMinor).toBe(2_300);
    });
  });

  describe('an unknown distance is not a fabricated one', () => {
    it('18. charges only the distance-independent part and says the distance is unknown', () => {
      const quote = DeliveryFeePolicy.quote(null, settings({ base: 2_000, perKm: 1_000 }));

      expect(quote.basis).toBe('BASE');
      expect(quote.distanceMeters).toBeNull();
      expect(quote.distanceFee).toBe(0);
      expect(quote.fee.amountMinor).toBe(2_000);
    });

    it('19. never matches a zone without a distance to match it against', () => {
      const quote = DeliveryFeePolicy.quote(
        null,
        settings({ zones: [{ id: 'inner', uptoMeters: 3_000, fee: 2_500 }] }),
      );

      expect(quote.zoneId).toBeNull();
    });

    it('20. refuses a negative distance rather than pricing from a broken adapter', async () => {
      expect(() => DeliveryFeePolicy.quote(-1, settings())).toThrow(ApiException);
    });
  });

  describe('money', () => {
    it('21. refuses a fractional amount', () => {
      expect(() => Money.base(12.5)).toThrow(ApiException);
    });

    it('22. refuses a negative delivery fee — that would be a refund, which is Module 07', () => {
      expect(() => Money.base(-100)).toThrow(ApiException);
    });

    it('23. accepts zero, because free delivery is an ordinary commercial decision', () => {
      expect(Money.base(0).isZero).toBe(true);
    });

    it('24. refuses a currency the platform does not settle in', () => {
      expect(() => Money.of(100, 'USD')).toThrow(ApiException);
    });

    it('25. quotes in the currency checkout and payment expect', () => {
      expect(DeliveryFeePolicy.quote(1_000, settings()).fee.currency).toBe('ETB');
    });
  });

  describe('the rate card as configuration', () => {
    it('26. resolves every key from the delivery namespace', () => {
      const config = new FakeConfig()
        .set('delivery.feeBase', 2_000)
        .set('delivery.feePerKm', 1_500)
        .set('delivery.feeMinimum', 2_500)
        .set('delivery.feeMaximum', 9_000)
        .set('delivery.feeRoundTo', 100)
        .set('delivery.feePricingVersion', 'rate-card-2026-q1')
        .set('delivery.feeZones', [{ id: 'inner', uptoMeters: 3_000, fee: 2_500 }]);

      expect(resolveDeliveryFeeSettings(config)).toEqual({
        pricingVersion: 'rate-card-2026-q1',
        base: 2_000,
        perKm: 1_500,
        minimum: 2_500,
        maximum: 9_000,
        roundTo: 100,
        zones: [{ id: 'inner', uptoMeters: 3_000, fee: 2_500 }],
      });
    });

    it('27. reads a maximum of zero as no cap at all', () => {
      expect(resolveDeliveryFeeSettings(new FakeConfig().set('delivery.feeMaximum', 0)).maximum)
        .toBeNull();
    });

    it('28. falls back to the documented zero defaults when nothing is configured', () => {
      expect(resolveDeliveryFeeSettings(new FakeConfig())).toEqual({
        pricingVersion: 'v1',
        base: 0,
        perKm: 0,
        minimum: 0,
        maximum: null,
        roundTo: 1,
        zones: [],
      });
    });

    it('29. accepts a zone rate card still in its operator string form', () => {
      const config = new FakeConfig().set('delivery.feeZones', 'inner:3000:2500,outer:9000:4000');

      expect(resolveDeliveryFeeSettings(config).zones).toEqual([
        { id: 'inner', uptoMeters: 3_000, fee: 2_500 },
        { id: 'outer', uptoMeters: 9_000, fee: 4_000 },
      ]);
    });

    it('30. parses zones into ascending order whatever order they were written in', () => {
      expect(parseDeliveryFeeZones('outer:9000:4000,inner:3000:2500').map((z) => z.id)).toEqual([
        'inner',
        'outer',
      ]);
    });

    it('31. reports a malformed rate card as invalid so boot can refuse it', () => {
      expect(isValidDeliveryFeeZones('inner:3000:2500')).toBe(true);
      expect(isValidDeliveryFeeZones('')).toBe(true);
      expect(isValidDeliveryFeeZones('inner:3000')).toBe(false);
      expect(isValidDeliveryFeeZones('inner:0:2500')).toBe(false);
      expect(isValidDeliveryFeeZones('inner:3000:-5')).toBe(false);
      expect(isValidDeliveryFeeZones(':3000:2500')).toBe(false);
    });
  });

  describe('the quote query', () => {
    it('32. prices a valid pickup and dropoff pair', async () => {
      const h = harness();
      h.config.set('delivery.feeBase', 2_000).set('delivery.feePerKm', 1_000);

      const quote = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(quote.deliveryFee).toBe(2_000 + 4_200);
      expect(quote.branchId).toBe(BRANCH);
      expect(quote.pharmacyId).toBe('pharmacy-1');
      expect(quote.currency).toBe('ETB');
    });

    it('33. takes its distance from IRoutingPort, between the two resolved points', async () => {
      const h = harness();
      h.routing.distanceMeters = 7_777;

      const quote = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(quote.distanceMeters).toBe(7_777);
      expect(h.routing.requests).toEqual([
        { origin: expect.objectContaining({ lat: 9.01, lng: 38.76 }), destination: expect.objectContaining({ lat: 8.98, lng: 38.79 }) },
      ]);
    });

    it('34. carries the routing provider travel-time estimate alongside the fee', async () => {
      const h = harness();

      expect(
        (await h.query.quote({ customerUserId: CUSTOMER, addressId: ADDRESS, branchId: BRANCH }))
          .estimatedDurationSeconds,
      ).toBe(690);
    });

    it('35. reports the basis and the rate-card version behind the number', async () => {
      const h = harness();
      h.config
        .set('delivery.feePricingVersion', 'rate-card-2026-q1')
        .set('delivery.feeZones', 'inner:5000:2500');

      const quote = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(quote.basis).toBe('ZONE');
      expect(quote.zoneId).toBe('inner');
      expect(quote.pricingVersion).toBe('rate-card-2026-q1');
    });

    it('36. asks the address port with the authenticated subject, never a supplied one', async () => {
      const h = harness();

      await h.query.quote({ customerUserId: CUSTOMER, addressId: ADDRESS, branchId: BRANCH });

      expect(h.addresses.asked).toEqual([{ addressId: ADDRESS, customerUserId: CUSTOMER }]);
    });

    it('37. answers NOT_FOUND for somebody else’s address — never FORBIDDEN', async () => {
      const h = harness();

      await expectApiError(
        h.query.quote({ customerUserId: 'user-2', addressId: ADDRESS, branchId: BRANCH }),
        ErrorCode.NOT_FOUND,
      );
    });

    it('38. answers NOT_FOUND for a branch that does not exist', async () => {
      const h = harness();

      await expectApiError(
        h.query.quote({ customerUserId: CUSTOMER, addressId: ADDRESS, branchId: 'nope' }),
        ErrorCode.NOT_FOUND,
      );
    });

    it('39. resolves the address before the branch, so branch ids leak nothing either', async () => {
      const h = harness();

      await expectApiError(
        h.query.quote({ customerUserId: 'user-2', addressId: ADDRESS, branchId: 'nope' }),
        ErrorCode.NOT_FOUND,
      );
      expect(h.routing.requests).toHaveLength(0);
    });

    it('40. refuses rather than fabricating a fee when routing returns nothing', async () => {
      const h = harness();
      h.config.set('delivery.feeBase', 2_000);
      h.routing.distanceMeters = null;

      await expectApiError(
        h.query.quote({ customerUserId: CUSTOMER, addressId: ADDRESS, branchId: BRANCH }),
        ErrorCode.DEPENDENCY_UNAVAILABLE,
      );
    });

    it('41. refuses just as firmly when the routing provider throws', async () => {
      const h = harness();
      h.routing.throws = true;

      await expectApiError(
        h.query.quote({ customerUserId: CUSTOMER, addressId: ADDRESS, branchId: BRANCH }),
        ErrorCode.DEPENDENCY_UNAVAILABLE,
      );
    });

    it('42. keeps coordinates out of the refusal it reports', async () => {
      const h = harness();
      h.routing.throws = true;

      const err = await expectApiError(
        h.query.quote({ customerUserId: CUSTOMER, addressId: ADDRESS, branchId: BRANCH }),
        ErrorCode.DEPENDENCY_UNAVAILABLE,
      );

      expect(JSON.stringify(err.details)).not.toContain('38.7');
      expect(JSON.stringify(err.details)).not.toContain('8.98');
    });

    it('43. does not call routing at all when the address has no coordinates', async () => {
      const h = harness();
      h.config.set('delivery.feeBase', 2_000).set('delivery.feePerKm', 1_000);
      h.addresses.seed(ADDRESS, CUSTOMER, { lat: null, lng: null });

      const quote = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(h.routing.requests).toHaveLength(0);
      expect(quote.basis).toBe('BASE');
      expect(quote.distanceMeters).toBeNull();
      expect(quote.deliveryFee).toBe(2_000);
    });

    it('44. does the same when the branch has no coordinates', async () => {
      const h = harness();
      h.pharmacies.seed(BRANCH, { lat: null, lng: null });

      const quote = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(h.routing.requests).toHaveLength(0);
      expect(quote.distanceMeters).toBeNull();
    });

    it('45. gives the same answer when asked twice — nothing is cached and nothing drifts', async () => {
      const h = harness();
      h.config.set('delivery.feeBase', 2_000).set('delivery.feePerKm', 1_000);

      const first = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });
      const second = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(second).toEqual(first);
      // Asked afresh each time: a cached quote could outlive a rate-card change, or be served to
      // somebody the authorization check would now refuse.
      expect(h.routing.requests).toHaveLength(2);
      expect(h.addresses.asked).toHaveLength(2);
    });

    it('46. reflects a rate-card change on the very next quote', async () => {
      const h = harness();
      const before = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });
      h.config.set('delivery.feeBase', 3_000);
      const after = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
      });

      expect(before.deliveryFee).toBe(0);
      expect(after.deliveryFee).toBe(3_000);
    });

    it('47. has no input through which a client could supply a distance or a fee', async () => {
      const h = harness();
      h.config.set('delivery.feePerKm', 1_000);

      const quote = await h.query.quote({
        customerUserId: CUSTOMER,
        addressId: ADDRESS,
        branchId: BRANCH,
        // A client trying its luck. The type has no such field, and the value is ignored.
        ...({ distanceMeters: 1, deliveryFee: 0 } as unknown as Record<string, never>),
      });

      expect(quote.distanceMeters).toBe(4_200);
      expect(quote.deliveryFee).toBe(4_200);
    });

    it('48. requires each identifier rather than quoting against a blank one', async () => {
      const h = harness();

      await expectApiError(
        h.query.quote({ customerUserId: CUSTOMER, addressId: '  ', branchId: BRANCH }),
        ErrorCode.VALIDATION_ERROR,
      );
      await expectApiError(
        h.query.quote({ customerUserId: '', addressId: ADDRESS, branchId: BRANCH }),
        ErrorCode.VALIDATION_ERROR,
      );
    });
  });
});
