import {
  MAX_DELIVERY_EARNING_AMOUNT,
  MAX_DELIVERY_EARNING_FEE_SHARE_PERCENT,
  MAX_DELIVERY_EARNING_ROUND_TO,
  MAX_DELIVERY_ETA_CACHE_TTL_SECONDS,
  MAX_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
  MAX_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
  MAX_DELIVERY_FEE_AMOUNT,
  MAX_DELIVERY_FEE_ROUND_TO,
  MAX_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
  MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  MAX_DELIVERY_MAX_CONCURRENT_JOBS,
  MAX_DELIVERY_OFFER_TTL_SECONDS,
  MAX_DELIVERY_POD_MAX_ARTIFACT_BYTES,
  MAX_DELIVERY_RECOVERY_BATCH_SIZE,
  MAX_DELIVERY_RECOVERY_QUIET_SECONDS,
  MAX_DELIVERY_STALE_ASSIGNMENT_SECONDS,
  MIN_DELIVERY_EARNING_AMOUNT,
  MIN_DELIVERY_EARNING_FEE_SHARE_PERCENT,
  MIN_DELIVERY_EARNING_ROUND_TO,
  MIN_DELIVERY_ETA_CACHE_TTL_SECONDS,
  MIN_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
  MIN_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
  MIN_DELIVERY_FEE_AMOUNT,
  MIN_DELIVERY_FEE_ROUND_TO,
  MIN_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
  MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  MIN_DELIVERY_OFFER_TTL_SECONDS,
  MIN_DELIVERY_POD_MAX_ARTIFACT_BYTES,
  MIN_DELIVERY_RECOVERY_BATCH_SIZE,
  MIN_DELIVERY_RECOVERY_QUIET_SECONDS,
  MIN_DELIVERY_STALE_ASSIGNMENT_SECONDS,
  DELIVERY_POD_REQUIREMENTS,
} from '../../../../shared/config/delivery.config';
import { ConfigValueType } from '../enums';

/**
 * What the catalogue knows about one governable setting.
 *
 * `min`/`max`/`allowed` are **copied from nowhere**. Each is imported from the constant the module
 * already enforces in `env.validation.ts`, so a bound cannot drift between "what an operator may
 * set through the API" and "what the same value may be when it arrives from the environment".
 */
export interface ConfigKeyDefinition {
  namespace: string;
  key: string;
  type: ConfigValueType;
  /** Inclusive lower bound, where the owning module already declares one. */
  min?: number;
  /** Inclusive upper bound, where the owning module already declares one. */
  max?: number;
  /** The permitted values, where the owning module already declares a closed set. */
  allowed?: readonly string[];
  /** What the setting does, for the admin UI. Never a value, never a secret. */
  description: string;
}

/**
 * Every configuration key an administrator may govern, and the only ones.
 *
 * ## Why an allow-list rather than "any key"
 *
 * This is the module's **security boundary**, not a convenience. `IConfigPort.get()` is how
 * `TelebirrConfig` reads `TELEBIRR_API_SECRET` and `TELEBIRR_WEBHOOK_SECRET`; `AppConfigService`
 * reads `JWT_ACCESS_SECRET`, `MASTER_ENCRYPTION_KEY` and a Redis URL that can carry a password. If
 * an administrator could create a configuration row for an arbitrary key, the Admin module would
 * become exactly the generic secret store §18 forbids — and worse, one that could *replace* a
 * payment provider's credential through an HTTP route.
 *
 * So the rule is inverted: nothing is governable unless it appears below. Every entry here is a
 * **business tunable** that a feature module already reads through `IConfigPort` under a dotted
 * namespace, which is precisely the surface that port was introduced for. Secrets are flat
 * `SCREAMING_SNAKE` environment names, they are not in this list, and a lookup for one therefore
 * never consults the override snapshot at all — it falls straight through to the environment, as it
 * does today.
 *
 * ## Why the bounds are imported rather than written
 *
 * §4 of the brief is emphatic that validation must enforce *existing* configuration contracts and
 * must not invent product policy. Every `min`, `max` and `allowed` below is the same constant
 * `env.validation.ts` applies to the corresponding environment variable. Where a module declares no
 * bound — `feePricingVersion`, the two COD booleans — none is asserted here either. Nobody decided
 * in this file what a delivery fee "should" be.
 *
 * ## What is deliberately absent
 *
 * - **`delivery.feeZones`.** Its environment form is an encoded band spec parsed by `readFeeZones`,
 *   while its effective form is a parsed array — two shapes with one validator, and the value sets
 *   delivery pricing. Governing it safely means deciding which shape the API accepts, and that is a
 *   decision worth making deliberately rather than as a line in a list.
 * - **The `redis` namespace.** `redis.url` can embed a password and `redis.keyPrefix` decides which
 *   keyspace every cache writes to. Both are infrastructure, both are read through
 *   `AppConfigService` rather than the port, and neither is a business parameter.
 * - **Everything Module 01, 03, 04, 05 and 09 read.** None of them reads a dotted namespace through
 *   `IConfigPort` today, so there is nothing to govern and nothing to get wrong.
 */
const DEFINITIONS: readonly ConfigKeyDefinition[] = [
  // -------------------------------------------------------------------------------------------
  // Module 06 — Orders
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'orders',
    key: 'platformFeePercent',
    type: ConfigValueType.DECIMAL,
    // A fraction, not a percentage number: 0.05 is 5%. The 0–1 bound is the one
    // `env.validation.ts` already applies to `ORDERS_PLATFORM_FEE_PERCENT`.
    min: 0,
    max: 1,
    description: 'Platform commission on an order subtotal, as a fraction between 0 and 1.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: dispatch and offers
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'maxConcurrentJobs',
    type: ConfigValueType.INTEGER,
    min: 1,
    max: MAX_DELIVERY_MAX_CONCURRENT_JOBS,
    description: 'How many delivery jobs one driver may hold at once.',
  },
  {
    namespace: 'delivery',
    key: 'offerTtlSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_OFFER_TTL_SECONDS,
    max: MAX_DELIVERY_OFFER_TTL_SECONDS,
    description: 'How long a driver has to answer a job offer before it expires.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: tracking and ETA
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'locationWriteIntervalSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
    max: MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
    description: 'Minimum gap between durable writes of a driver position.',
  },
  {
    namespace: 'delivery',
    key: 'locationCacheTtlSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
    max: MAX_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
    description: 'How long a hot last-known position survives in Redis.',
  },
  {
    namespace: 'delivery',
    key: 'etaCacheTtlSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_ETA_CACHE_TTL_SECONDS,
    max: MAX_DELIVERY_ETA_CACHE_TTL_SECONDS,
    description: 'How long a computed route may be reused before recalculation.',
  },
  {
    namespace: 'delivery',
    key: 'etaRecalculateAfterMeters',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
    max: MAX_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
    description: 'How far a driver may move before the ETA is recomputed.',
  },
  {
    namespace: 'delivery',
    key: 'etaMaxLocationAgeSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
    max: MAX_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
    description: 'How stale a position may be and still support an ETA.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: proof of delivery
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'podRequirement',
    type: ConfigValueType.STRING,
    allowed: DELIVERY_POD_REQUIREMENTS,
    description: 'How much proof of delivery every delivery needs.',
  },
  {
    namespace: 'delivery',
    key: 'podColdChainRequirement',
    type: ConfigValueType.STRING,
    allowed: DELIVERY_POD_REQUIREMENTS,
    description: 'Proof-of-delivery requirement for a cold-chain delivery.',
  },
  {
    namespace: 'delivery',
    key: 'podCodRequirement',
    type: ConfigValueType.STRING,
    allowed: DELIVERY_POD_REQUIREMENTS,
    description: 'Proof-of-delivery requirement for a cash-on-delivery delivery.',
  },
  {
    namespace: 'delivery',
    key: 'podMaxArtifactBytes',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_POD_MAX_ARTIFACT_BYTES,
    max: MAX_DELIVERY_POD_MAX_ARTIFACT_BYTES,
    description: 'Largest proof-of-delivery artifact accepted, in bytes.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: the customer-facing fee
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'feeBase',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_FEE_AMOUNT,
    max: MAX_DELIVERY_FEE_AMOUNT,
    description: 'Flat component of the delivery fee, in ETB minor units.',
  },
  {
    namespace: 'delivery',
    key: 'feePerKm',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_FEE_AMOUNT,
    max: MAX_DELIVERY_FEE_AMOUNT,
    description: 'Distance component of the delivery fee, in ETB minor units per km.',
  },
  {
    namespace: 'delivery',
    key: 'feeMinimum',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_FEE_AMOUNT,
    max: MAX_DELIVERY_FEE_AMOUNT,
    description: 'Floor applied to a computed delivery fee, in ETB minor units.',
  },
  {
    namespace: 'delivery',
    key: 'feeMaximum',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_FEE_AMOUNT,
    max: MAX_DELIVERY_FEE_AMOUNT,
    description: 'Ceiling applied to a computed delivery fee; 0 means no ceiling.',
  },
  {
    namespace: 'delivery',
    key: 'feeRoundTo',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_FEE_ROUND_TO,
    max: MAX_DELIVERY_FEE_ROUND_TO,
    description: 'Rounding increment for the delivery fee, in ETB minor units.',
  },
  {
    namespace: 'delivery',
    key: 'feePricingVersion',
    type: ConfigValueType.STRING,
    // No bound: the module declares none. It is a label stamped onto a quote.
    description: 'Label stamped onto a delivery-fee quote to identify the rate card used.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: what the driver earns
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'earningBase',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_EARNING_AMOUNT,
    max: MAX_DELIVERY_EARNING_AMOUNT,
    description: 'Flat component of a driver earning, in ETB minor units.',
  },
  {
    namespace: 'delivery',
    key: 'earningPerKm',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_EARNING_AMOUNT,
    max: MAX_DELIVERY_EARNING_AMOUNT,
    description: 'Distance component of a driver earning, in ETB minor units per km.',
  },
  {
    namespace: 'delivery',
    key: 'earningFeeSharePercent',
    type: ConfigValueType.DECIMAL,
    min: MIN_DELIVERY_EARNING_FEE_SHARE_PERCENT,
    max: MAX_DELIVERY_EARNING_FEE_SHARE_PERCENT,
    description: 'Share of the delivery fee paid to the driver, as a fraction between 0 and 1.',
  },
  {
    namespace: 'delivery',
    key: 'earningMinimum',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_EARNING_AMOUNT,
    max: MAX_DELIVERY_EARNING_AMOUNT,
    description: 'Floor applied to a computed driver earning, in ETB minor units.',
  },
  {
    namespace: 'delivery',
    key: 'earningMaximum',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_EARNING_AMOUNT,
    max: MAX_DELIVERY_EARNING_AMOUNT,
    description: 'Ceiling applied to a driver earning; 0 means no ceiling.',
  },
  {
    namespace: 'delivery',
    key: 'earningRoundTo',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_EARNING_ROUND_TO,
    max: MAX_DELIVERY_EARNING_ROUND_TO,
    description: 'Rounding increment for a driver earning, in ETB minor units.',
  },
  {
    namespace: 'delivery',
    key: 'earningVersion',
    type: ConfigValueType.STRING,
    description: 'Label stamped onto an accrued earning to identify the rate card used.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: cash on delivery
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'codRequireExactAmount',
    type: ConfigValueType.BOOLEAN,
    description: 'Whether a driver must collect exactly the expected cash amount.',
  },
  {
    namespace: 'delivery',
    key: 'codRequireCollectionForCompletion',
    type: ConfigValueType.BOOLEAN,
    description: 'Whether a COD job must have a recorded collection before it completes.',
  },

  // -------------------------------------------------------------------------------------------
  // Module 08 — Delivery: background recovery workers
  // -------------------------------------------------------------------------------------------
  {
    namespace: 'delivery',
    key: 'recoveryBatchSize',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_RECOVERY_BATCH_SIZE,
    max: MAX_DELIVERY_RECOVERY_BATCH_SIZE,
    description: 'Most rows one background recovery tick may process.',
  },
  {
    namespace: 'delivery',
    key: 'recoveryQuietSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_RECOVERY_QUIET_SECONDS,
    max: MAX_DELIVERY_RECOVERY_QUIET_SECONDS,
    description: 'How long a job must sit untouched before recovery treats it as stalled.',
  },
  {
    namespace: 'delivery',
    key: 'staleAssignmentSeconds',
    type: ConfigValueType.INTEGER,
    min: MIN_DELIVERY_STALE_ASSIGNMENT_SECONDS,
    max: MAX_DELIVERY_STALE_ASSIGNMENT_SECONDS,
    description: 'How long a pre-pickup job may sit with a driver who has stopped working.',
  },
];

const BY_PATH = new Map<string, ConfigKeyDefinition>(
  DEFINITIONS.map((definition) => [`${definition.namespace}.${definition.key}`, definition]),
);

/**
 * The governable configuration surface (module-16 §6).
 *
 * A frozen registry, not a table: these are the keys the *code* reads, so they change when the code
 * changes, and an administrator who could add a row for a key nothing reads would be configuring
 * nothing while believing otherwise.
 */
export const ConfigCatalogue = {
  /** Every governable key, in declaration order. */
  all(): readonly ConfigKeyDefinition[] {
    return DEFINITIONS;
  },

  /** Every governable key in one namespace. */
  forNamespace(namespace: string): readonly ConfigKeyDefinition[] {
    return DEFINITIONS.filter((definition) => definition.namespace === namespace);
  },

  /** The definition for a dotted path, or `null` when the key is not governable. */
  find(namespace: string, key: string): ConfigKeyDefinition | null {
    return BY_PATH.get(`${namespace}.${key}`) ?? null;
  },

  /**
   * Whether a dotted path may be served from the override snapshot.
   *
   * The question `PlatformConfigResolver` asks on every `get()`. A path that is not catalogued is
   * not looked up at all — which is what keeps `TELEBIRR_API_SECRET` and `JWT_ACCESS_SECRET`
   * resolving from the environment no matter what rows exist in `platform_configs`.
   */
  isGovernable(path: string): boolean {
    return BY_PATH.has(path);
  },

  /** The distinct namespaces that contain at least one governable key. */
  namespaces(): readonly string[] {
    return [...new Set(DEFINITIONS.map((definition) => definition.namespace))];
  },
} as const;
