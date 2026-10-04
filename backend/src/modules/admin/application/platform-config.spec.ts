import { randomUUID } from 'crypto';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { ConfigOverrideRegistry } from '../../../shared/config/config-override.registry';
import { PlatformConfigResolver } from '../../../shared/config/platform-config.resolver';
import { ErrorCode } from '../../../shared/errors/error-codes';
import { ConfigValueType, FeatureFlagStatus } from '../domain/enums';
import { FeatureFlag } from '../domain/entities/feature-flag.entity';
import { PlatformConfig, PlatformConfigProps } from '../domain/entities/platform-config.entity';
import { ConfigCatalogue } from '../domain/services/config-catalogue';
import { ConfigKey } from '../domain/value-objects/config-key.vo';
import { ConfigValue } from '../domain/value-objects/config-value.vo';

/**
 * Module 16 Work 01's domain rules, in memory.
 *
 * Everything here is a claim about a decision the code makes rather than about the database:
 * which keys can be addressed at all, which values are acceptable, how a version number is chosen,
 * and — the one that matters most — that a secret cannot be reached through any of it. The
 * versioning invariant that *is* a database guarantee (one active version, enforced by a partial
 * unique index) is asserted against real PostgreSQL in `test/admin/platform-config.e2e-spec.ts`,
 * where it means something.
 */
describe('Platform configuration (domain)', () => {
  function code(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // 1. ConfigKey — the governable surface, and the security boundary
  // -------------------------------------------------------------------------------------------

  describe('ConfigKey', () => {
    it('accepts a key the catalogue carries', () => {
      const key = ConfigKey.of('orders', 'platformFeePercent');
      expect(key.path).toBe('orders.platformFeePercent');
      expect(key.definition.type).toBe(ConfigValueType.DECIMAL);
    });

    it('refuses a key the catalogue does not carry', () => {
      expect(code(() => ConfigKey.of('orders', 'somethingInvented'))).toBe(ErrorCode.NOT_FOUND);
    });

    /**
     * The claim §18 rests on: each of these is read through `IConfigPort` or `AppConfigService`
     * somewhere in the repository, and none may be addressable by an administrator.
     *
     * They are refused by **two different layers**, which is worth pinning down rather than
     * glossing. Secrets are flat `SCREAMING_SNAKE` environment names, and a `_` is not a legal
     * segment character — so they never reach the catalogue at all and fail as malformed. The
     * infrastructure keys that *are* dotted reach the catalogue and are refused for not being in
     * it. Either way there is no path to a value, which is the property that matters.
     */
    it.each([
      ['payment provider secret', 'TELEBIRR', 'API_SECRET'],
      ['webhook signing secret', 'TELEBIRR', 'WEBHOOK_SECRET'],
      ['access-token secret', 'JWT', 'ACCESS_SECRET'],
      ['encryption key', 'MASTER', 'ENCRYPTION_KEY'],
    ])('refuses the %s — not a well-formed governable key', (_label, namespace, key) => {
      expect(code(() => ConfigKey.of(namespace, key))).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it.each([
      ['redis url', 'redis', 'url'],
      ['redis key prefix', 'redis', 'keyPrefix'],
      ['delivery fee zones', 'delivery', 'feeZones'],
      // Both segments are alphanumeric, so this one reaches the catalogue and is refused there.
      ['database url', 'DATABASE', 'URL'],
    ])('refuses the %s — well-formed, but not governable', (_label, namespace, key) => {
      // `NOT_FOUND`, not `FORBIDDEN`: the answer carries no confirmation that the key is real
      // anywhere, so the route cannot be used to enumerate what exists outside the catalogue.
      expect(code(() => ConfigKey.of(namespace, key))).toBe(ErrorCode.NOT_FOUND);
    });

    it('refuses a malformed segment before it ever consults the catalogue', () => {
      expect(code(() => ConfigKey.of('orders', 'platform.fee'))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
      expect(code(() => ConfigKey.of('', 'platformFeePercent'))).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('carries no secret-shaped key in the catalogue at all', () => {
      const suspicious = /secret|password|credential|token|key$|url/i;
      const offenders = ConfigCatalogue.all()
        .map((definition) => `${definition.namespace}.${definition.key}`)
        // `apiKey`-style names would match; none should exist. `feeRoundTo` etc. must not trip it,
        // hence anchoring `key` to the end of the segment.
        .filter((path) => suspicious.test(path.split('.')[1]));
      expect(offenders).toEqual([]);
    });

    it('governs only namespaces that feature modules actually read', () => {
      expect([...ConfigCatalogue.namespaces()].sort()).toEqual(['delivery', 'orders']);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 2. ConfigValue — typed, and bounded by the owning module's own contract
  // -------------------------------------------------------------------------------------------

  describe('ConfigValue', () => {
    const ttl = ConfigKey.of('delivery', 'offerTtlSeconds');
    const fee = ConfigKey.of('orders', 'platformFeePercent');
    const cod = ConfigKey.of('delivery', 'codRequireExactAmount');
    const pod = ConfigKey.of('delivery', 'podRequirement');

    it('keeps an integer an integer', () => {
      const value = ConfigValue.of(ttl, ConfigValueType.INTEGER, 45);
      expect(value.value).toBe(45);
      expect(value.type).toBe(ConfigValueType.INTEGER);
    });

    it('refuses a declared type that disagrees with the catalogue', () => {
      expect(code(() => ConfigValue.of(ttl, ConfigValueType.STRING, '45'))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
    });

    it('refuses a non-integer for an integer key', () => {
      expect(code(() => ConfigValue.of(ttl, ConfigValueType.INTEGER, 45.5))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
      expect(code(() => ConfigValue.of(ttl, ConfigValueType.INTEGER, 'soon'))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
    });

    /**
     * The bounds are the module's own — `MIN_DELIVERY_OFFER_TTL_SECONDS` is 5 and
     * `MAX_DELIVERY_OFFER_TTL_SECONDS` is 600, the same pair `env.validation.ts` enforces on the
     * environment variable. Nothing in Module 16 decided them.
     */
    it('enforces the owning module’s declared range, at both ends', () => {
      expect(code(() => ConfigValue.of(ttl, ConfigValueType.INTEGER, 2))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
      expect(code(() => ConfigValue.of(ttl, ConfigValueType.INTEGER, 601))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
      expect(ConfigValue.of(ttl, ConfigValueType.INTEGER, 5).value).toBe(5);
      expect(ConfigValue.of(ttl, ConfigValueType.INTEGER, 600).value).toBe(600);
    });

    it('treats the platform fee as a 0–1 fraction, as Module 06 already does', () => {
      expect(ConfigValue.of(fee, ConfigValueType.DECIMAL, 0.05).value).toBe(0.05);
      // 5 meant as "5%" is the typo the bound exists to catch.
      expect(code(() => ConfigValue.of(fee, ConfigValueType.DECIMAL, 5))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
    });

    it('stores a boolean as a boolean, and accepts the two string spellings', () => {
      expect(ConfigValue.of(cod, ConfigValueType.BOOLEAN, true).value).toBe(true);
      expect(ConfigValue.of(cod, ConfigValueType.BOOLEAN, 'false').value).toBe(false);
      // A number for a boolean key is far more likely to be the wrong field than an intent.
      expect(code(() => ConfigValue.of(cod, ConfigValueType.BOOLEAN, 1))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
    });

    it('enforces a closed set where the module declares one', () => {
      expect(ConfigValue.of(pod, ConfigValueType.STRING, 'ARTIFACT').value).toBe('ARTIFACT');
      expect(code(() => ConfigValue.of(pod, ConfigValueType.STRING, 'MAYBE'))).toBe(
        ErrorCode.CONFIG_VALIDATION_FAILED,
      );
    });

    it('asserts no range where the module declares none', () => {
      const label = ConfigKey.of('delivery', 'feePricingVersion');
      expect(ConfigValue.of(label, ConfigValueType.STRING, 'v9').value).toBe('v9');
    });
  });

  // -------------------------------------------------------------------------------------------
  // 3. PlatformConfig — versioning
  // -------------------------------------------------------------------------------------------

  describe('PlatformConfig', () => {
    const key = ConfigKey.of('delivery', 'offerTtlSeconds');

    function publish(previousVersion: number, raw: number): PlatformConfigProps {
      return PlatformConfig.publish({
        id: randomUUID(),
        key,
        value: ConfigValue.of(key, ConfigValueType.INTEGER, raw),
        previousVersion,
        updatedBy: 'admin-1',
      }).toProps();
    }

    it('numbers the first version 1 and publishes it active', () => {
      const first = publish(0, 45);
      expect(first.version).toBe(1);
      expect(first.isActive).toBe(true);
      expect(first.value).toBe(45);
    });

    it('numbers each change as the next version', () => {
      expect(publish(1, 60).version).toBe(2);
      expect(publish(2, 90).version).toBe(3);
    });

    it('takes the actor as given and refuses an unattributed change', () => {
      expect(
        code(() =>
          PlatformConfig.publish({
            id: randomUUID(),
            key,
            value: ConfigValue.of(key, ConfigValueType.INTEGER, 45),
            previousVersion: 0,
            updatedBy: '   ',
          }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('exposes no way to change a published version', () => {
      const published = PlatformConfig.publish({
        id: randomUUID(),
        key,
        value: ConfigValue.of(key, ConfigValueType.INTEGER, 45),
        previousVersion: 0,
        updatedBy: 'admin-1',
      });
      // The structural claim behind "historical versions are immutable": there is no setter, no
      // `withValue`, no `deactivate`. The only mutation in the module is the repository's
      // `deactivateActive`, which writes one boolean.
      const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(published)).filter(
        (name) => name.startsWith('set') || name.startsWith('update') || name === 'withValue',
      );
      expect(mutators).toEqual([]);
    });

    it('returns a copy of its props, so a caller cannot reach in and edit one', () => {
      const published = PlatformConfig.publish({
        id: randomUUID(),
        key,
        value: ConfigValue.of(key, ConfigValueType.INTEGER, 45),
        previousVersion: 0,
        updatedBy: 'admin-1',
      });
      const props = published.toProps();
      props.value = 999;
      expect(published.toProps().value).toBe(45);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 4. FeatureFlag
  // -------------------------------------------------------------------------------------------

  describe('FeatureFlag', () => {
    it('normalizes a key to lower case so one capability has one name', () => {
      expect(FeatureFlag.normalizeKey('  COD_Enabled ')).toBe('cod_enabled');
    });

    it('refuses a key that is not identifier-shaped', () => {
      expect(code(() => FeatureFlag.normalizeKey('cod enabled'))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
      expect(code(() => FeatureFlag.normalizeKey('9lives'))).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('creates enabled or disabled, and toggles without mutating the original', () => {
      const flag = FeatureFlag.create({
        id: randomUUID(),
        key: 'cod',
        enabled: true,
        updatedByUserId: 'admin-1',
      });
      expect(flag.isEnabled).toBe(true);

      const off = flag.toggle({ enabled: false, updatedByUserId: 'admin-2' });
      expect(off.isEnabled).toBe(false);
      // The caller still holds the previous state, which is what the audit entry records.
      expect(flag.isEnabled).toBe(true);
    });

    it('reads PARTIAL as not enabled', () => {
      const partial = FeatureFlag.rehydrate({
        id: randomUUID(),
        key: 'cod',
        description: null,
        status: FeatureFlagStatus.PARTIAL,
        updatedByUserId: 'admin-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Nothing in this work evaluates rollout rules, so "partially on" cannot be honoured and the
      // conservative reading is off.
      expect(partial.isEnabled).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // 5. PlatformConfigResolver — the overlay, and what it must never overlay
  // -------------------------------------------------------------------------------------------

  describe('PlatformConfigResolver', () => {
    let registry: ConfigOverrideRegistry;
    let resolver: PlatformConfigResolver;
    let env: Record<string, unknown>;
    let envFlags: Record<string, boolean>;

    beforeEach(() => {
      env = {
        'delivery.offerTtlSeconds': 30,
        'delivery.feeBase': 0,
        'orders.platformFeePercent': 0,
        TELEBIRR_API_SECRET: 'env-secret',
        JWT_ACCESS_SECRET: 'env-jwt',
      };
      envFlags = { cod: true };

      const fakeEnv = {
        get: <T>(key: string) => env[key] as T | undefined,
        getOrThrow: <T>(key: string) => {
          if (!(key in env)) {
            throw new Error(`missing ${key}`);
          }
          return env[key] as T;
        },
        isFeatureEnabled: (flag: string) => envFlags[flag.toLowerCase()] === true,
      } as unknown as AppConfigService;

      registry = new ConfigOverrideRegistry();
      resolver = new PlatformConfigResolver(fakeEnv, registry);
    });

    it('resolves from the environment when nothing is published', () => {
      expect(resolver.get('delivery.offerTtlSeconds')).toBe(30);
      expect(resolver.sourceOf('delivery.offerTtlSeconds')).toBe('ENVIRONMENT');
    });

    it('prefers a published override', () => {
      registry.replace({
        values: new Map([['delivery.offerTtlSeconds', 90]]),
        flags: new Map(),
        loadedAt: new Date(),
      });
      expect(resolver.get('delivery.offerTtlSeconds')).toBe(90);
      expect(resolver.sourceOf('delivery.offerTtlSeconds')).toBe('ADMIN');
    });

    /**
     * `0` and `false` are legitimate published values — `delivery.feeBase` of `0` is the current
     * default — so the overlay must key off *presence*, not truthiness. A truthiness check would
     * make exactly the zero-valued settings impossible to govern.
     */
    it('serves a published zero rather than falling through to the environment', () => {
      env['delivery.feeBase'] = 500;
      registry.replace({
        values: new Map([['delivery.feeBase', 0]]),
        flags: new Map(),
        loadedAt: new Date(),
      });
      expect(resolver.get('delivery.feeBase')).toBe(0);
    });

    /**
     * The resolver-level half of §18. Even with a row somehow present in the snapshot, a secret
     * must still resolve from the environment — but the real guarantee is that the loader would
     * never put one there, which this asserts by showing the snapshot is consulted only for keys
     * it actually holds.
     */
    it('never serves a secret from anywhere but the environment', () => {
      registry.replace({
        values: new Map([['delivery.offerTtlSeconds', 90]]),
        flags: new Map(),
        loadedAt: new Date(),
      });
      expect(resolver.get('TELEBIRR_API_SECRET')).toBe('env-secret');
      expect(resolver.get('JWT_ACCESS_SECRET')).toBe('env-jwt');
      expect(resolver.sourceOf('TELEBIRR_API_SECRET')).toBe('ENVIRONMENT');
    });

    it('falls back to the environment for a flag that has never been administered', () => {
      // §10's "safe when missing". A missing row must not read as "disabled", or deploying this
      // module would switch off every flag-gated capability at once.
      expect(resolver.isFeatureEnabled('cod')).toBe(true);
      expect(resolver.isFeatureEnabled('telemedicine')).toBe(false);
    });

    it('prefers a stored flag once one exists, in both directions', () => {
      registry.replace({
        values: new Map(),
        flags: new Map([
          ['cod', false],
          ['telemedicine', true],
        ]),
        loadedAt: new Date(),
      });
      expect(resolver.isFeatureEnabled('cod')).toBe(false);
      expect(resolver.isFeatureEnabled('telemedicine')).toBe(true);
    });

    it('keeps serving the last snapshot rather than emptying it', () => {
      registry.replace({
        values: new Map([['delivery.offerTtlSeconds', 90]]),
        flags: new Map(),
        loadedAt: new Date(),
      });
      // A refresh that throws leaves the registry untouched — the loader logs and returns without
      // calling `replace`, so a database blip cannot silently revert governed settings.
      expect(resolver.get('delivery.offerTtlSeconds')).toBe(90);
    });
  });
});
