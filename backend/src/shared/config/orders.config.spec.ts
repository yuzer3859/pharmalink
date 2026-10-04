import { ordersConfig, readPlatformFeePercent } from './orders.config';
import { validateEnv } from './env.validation';

/**
 * The commission's configuration boundary.
 *
 * Worth its own tests because the failure mode is silent: before the `orders` namespace existed,
 * `ConfigService` had no source for the dotted key every Module 06 caller reads, so the rate was
 * always `undefined` and every order was priced at a 0% commission no matter what was configured.
 * Nothing failed — the platform just never charged anyone. These tests pin the two halves that
 * prevent a recurrence: the namespace produces a value, and a nonsense value is refused at boot.
 */
describe('orders configuration', () => {
  describe('readPlatformFeePercent', () => {
    it('defaults to zero when unset — a commission is never assumed', () => {
      // There is no safe non-zero default. Guessing one would silently start charging pharmacies
      // a rate nobody chose, which is worse than charging nothing.
      expect(readPlatformFeePercent({})).toBe(0);
    });

    it('treats an empty or whitespace value as unset rather than as NaN', () => {
      expect(readPlatformFeePercent({ ORDERS_PLATFORM_FEE_PERCENT: '' })).toBe(0);
      expect(readPlatformFeePercent({ ORDERS_PLATFORM_FEE_PERCENT: '   ' })).toBe(0);
    });

    it('reads the rate as a fraction, not as a percentage number', () => {
      // 0.05 is 5%. This is `PricingCalculator`'s existing 0–1 contract, which the env var feeds
      // unchanged — a value of `5` would mean 500% and is refused by validation below.
      expect(readPlatformFeePercent({ ORDERS_PLATFORM_FEE_PERCENT: '0.05' })).toBe(0.05);
      expect(readPlatformFeePercent({ ORDERS_PLATFORM_FEE_PERCENT: '0' })).toBe(0);
      expect(readPlatformFeePercent({ ORDERS_PLATFORM_FEE_PERCENT: '1' })).toBe(1);
    });
  });

  describe('the registered namespace', () => {
    const original = process.env.ORDERS_PLATFORM_FEE_PERCENT;
    afterEach(() => {
      if (original === undefined) {
        delete process.env.ORDERS_PLATFORM_FEE_PERCENT;
      } else {
        process.env.ORDERS_PLATFORM_FEE_PERCENT = original;
      }
    });

    it('produces the key Module 06 actually reads', () => {
      process.env.ORDERS_PLATFORM_FEE_PERCENT = '0.05';

      // `ConfigService.get('orders.platformFeePercent')` resolves through this object, so the
      // shape here *is* the dotted key the four Module 06 call sites use.
      expect(ordersConfig()).toEqual({ platformFeePercent: 0.05 });
    });
  });

  describe('boot-time validation', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      JWT_ACCESS_SECRET: 'a-sufficiently-long-access-secret',
      JWT_REFRESH_SECRET: 'a-sufficiently-long-refresh-secret',
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };

    it('accepts a rate inside 0–1 and coerces the string form', () => {
      expect(validateEnv({ ...base, ORDERS_PLATFORM_FEE_PERCENT: '0.05' })
        .ORDERS_PLATFORM_FEE_PERCENT).toBe(0.05);
    });

    it('accepts an absent rate, defaulting to zero', () => {
      expect(validateEnv(base).ORDERS_PLATFORM_FEE_PERCENT).toBe(0);
    });

    it('refuses a rate above 1 — the "5 meant as 5%" typo', () => {
      // A 500% commission discovered by a customer is the outcome this bound prevents.
      // `PricingCalculator` would reject it too, but only at the first checkout; failing at boot
      // is the difference between a deployment that does not start and one that mis-prices orders.
      expect(() => validateEnv({ ...base, ORDERS_PLATFORM_FEE_PERCENT: '5' })).toThrow(
        /Invalid environment configuration/,
      );
    });

    it('refuses a negative rate and a non-numeric one', () => {
      expect(() => validateEnv({ ...base, ORDERS_PLATFORM_FEE_PERCENT: '-0.1' })).toThrow(
        /Invalid environment configuration/,
      );
      expect(() => validateEnv({ ...base, ORDERS_PLATFORM_FEE_PERCENT: 'five percent' })).toThrow(
        /Invalid environment configuration/,
      );
    });
  });
});
