import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS,
  DEFAULT_DELIVERY_POD_COD_REQUIREMENT,
  DEFAULT_DELIVERY_POD_COLD_CHAIN_REQUIREMENT,
  DEFAULT_DELIVERY_POD_MAX_ARTIFACT_BYTES,
  DEFAULT_DELIVERY_POD_REQUIREMENT,
  DELIVERY_POD_REQUIREMENTS,
  DeliveryPodRequirement,
  DEFAULT_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
  DEFAULT_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
  DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
  DEFAULT_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS,
  DEFAULT_DELIVERY_OFFER_TTL_SECONDS,
  DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE,
  DEFAULT_DELIVERY_RECOVERY_QUIET_SECONDS,
  DEFAULT_DELIVERY_STALE_ASSIGNMENT_SECONDS,
  MAX_DELIVERY_RECOVERY_BATCH_SIZE,
  MAX_DELIVERY_RECOVERY_QUIET_SECONDS,
  MAX_DELIVERY_STALE_ASSIGNMENT_SECONDS,
  MIN_DELIVERY_RECOVERY_BATCH_SIZE,
  MIN_DELIVERY_RECOVERY_QUIET_SECONDS,
  MIN_DELIVERY_STALE_ASSIGNMENT_SECONDS,
  MAX_DELIVERY_ETA_CACHE_TTL_SECONDS,
  MAX_DELIVERY_POD_MAX_ARTIFACT_BYTES,
  MAX_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
  MAX_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
  MAX_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
  MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  MAX_DELIVERY_MAX_CONCURRENT_JOBS,
  MAX_DELIVERY_OFFER_TTL_SECONDS,
  MIN_DELIVERY_ETA_CACHE_TTL_SECONDS,
  MIN_DELIVERY_POD_MAX_ARTIFACT_BYTES,
  MIN_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS,
  MIN_DELIVERY_ETA_RECALCULATE_AFTER_METERS,
  MIN_DELIVERY_LOCATION_CACHE_TTL_SECONDS,
  MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS,
  MIN_DELIVERY_OFFER_TTL_SECONDS,
  DEFAULT_DELIVERY_FEE_BASE,
  DEFAULT_DELIVERY_FEE_MAXIMUM,
  DEFAULT_DELIVERY_FEE_MINIMUM,
  DEFAULT_DELIVERY_FEE_PER_KM,
  DEFAULT_DELIVERY_FEE_PRICING_VERSION,
  DEFAULT_DELIVERY_FEE_ROUND_TO,
  DEFAULT_DELIVERY_FEE_ZONES,
  MAX_DELIVERY_FEE_AMOUNT,
  MAX_DELIVERY_FEE_ROUND_TO,
  MIN_DELIVERY_FEE_AMOUNT,
  MIN_DELIVERY_FEE_ROUND_TO,
  isValidDeliveryFeeZones,
  DEFAULT_DELIVERY_EARNING_BASE,
  DEFAULT_DELIVERY_EARNING_FEE_SHARE_PERCENT,
  DEFAULT_DELIVERY_EARNING_MAXIMUM,
  DEFAULT_DELIVERY_EARNING_MINIMUM,
  DEFAULT_DELIVERY_EARNING_PER_KM,
  DEFAULT_DELIVERY_EARNING_ROUND_TO,
  DEFAULT_DELIVERY_EARNING_VERSION,
  MAX_DELIVERY_EARNING_AMOUNT,
  MAX_DELIVERY_EARNING_FEE_SHARE_PERCENT,
  MAX_DELIVERY_EARNING_ROUND_TO,
  MIN_DELIVERY_EARNING_AMOUNT,
  MIN_DELIVERY_EARNING_FEE_SHARE_PERCENT,
  MIN_DELIVERY_EARNING_ROUND_TO,
  DEFAULT_DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION,
  DEFAULT_DELIVERY_COD_REQUIRE_EXACT_AMOUNT,
} from './delivery.config';
import { DEFAULT_ORDERS_PLATFORM_FEE_PERCENT } from './orders.config';
import { DEFAULT_REDIS_KEY_PREFIX } from './redis.config';

/**
 * Rejects a malformed `DELIVERY_FEE_ZONES` string at boot.
 *
 * A custom constraint rather than a `@Matches` regex because the rule is not only syntactic: a
 * band needs a positive `uptoMeters` and a fee inside the persistable range, and a regex that
 * accepted `inner:0:2000` would let a zone through that the parser then silently drops. The parser
 * and the validator are therefore the *same* function asked two different ways — `parseDeliveryFeeZones`
 * keeps what it understands, and this reports a mismatch between what was written and what
 * survived. They cannot disagree about what a valid zone is, because there is only one of them.
 *
 * Failing at boot is the point. A typo in a rate card that fell back to "no zones" would mean
 * every delivery priced by the distance formula while an operator believed their bands were live,
 * and nothing would surface the difference except a month of wrong invoices.
 */
@ValidatorConstraint({ name: 'deliveryFeeZones', async: false })
export class DeliveryFeeZonesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value !== 'string' || isValidDeliveryFeeZones(value);
  }

  defaultMessage(): string {
    return 'DELIVERY_FEE_ZONES must be comma-separated id:uptoMeters:feeMinorUnits entries, e.g. "inner:3000:2000,outer:9000:4000".';
  }
}

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Schema for all environment variables consumed by the app.
 * Only Phase-0 variables are required; later phases add their own (documented in
 * architecture/00-implementation-roadmap.md §7) and can be validated here as they land.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  @IsOptional()
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(0)
  @IsOptional()
  PORT = 3000;

  @IsString()
  @IsOptional()
  WEB_ORIGIN?: string;

  @IsString()
  @MinLength(1)
  DATABASE_URL!: string;

  /**
   * Where the shared Redis lives, e.g. `redis://localhost:6379`. Backs `redis.url`.
   *
   * Declared here since Phase 0 and unread until the delivery tracking work; `redis.config.ts` is
   * what now gives `ConfigService` a value for the dotted key, and `RedisService` is what opens
   * the connection.
   *
   * **Optional on purpose.** Redis is a hot store — tracking fan-out and last-known-location
   * caching — and never a system of record, so the application boots and serves every route
   * without it, degrading to single-node fan-out. Only validated as a string: a URL this app
   * cannot reach is a connectivity problem to be reported and survived at runtime, not something a
   * regex at boot can rule out.
   */
  @IsString()
  @IsOptional()
  REDIS_URL?: string;

  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(16)
  JWT_REFRESH_SECRET!: string;

  /**
   * Base64-encoded 32-byte master key used by the envelope-encryption helper to wrap
   * per-record data keys. In production this is replaced by a real KMS (see CryptoService).
   */
  @IsString()
  @MinLength(44)
  MASTER_ENCRYPTION_KEY!: string;

  /**
   * The platform's commission rate, as a **fraction**: `0.05` is 5%. Backs the
   * `orders.platformFeePercent` config key (see `orders.config.ts`), which `PricingCalculator`
   * multiplies by the order subtotal.
   *
   * Optional, defaulting to `0` — the platform must run without a configured commission, which is
   * how it has run until now. But it is validated whenever it *is* set, because unlike the
   * optional gateway credentials (which `TelebirrConfig` deliberately keeps out of this schema) a
   * wrong value here does not disable a feature: it silently mis-prices every order placed. The
   * two bounds are the ones `PricingCalculator` itself enforces, asserted here as well so a
   * typo fails at boot rather than at the first checkout — `5` meant as "5%" would otherwise be a
   * 500% commission discovered by a customer.
   */
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  ORDERS_PLATFORM_FEE_PERCENT: number = DEFAULT_ORDERS_PLATFORM_FEE_PERCENT;

  /**
   * How many delivery jobs one driver may hold at once (BRULE-28). Backs the
   * `delivery.maxConcurrentJobs` config key (see `delivery.config.ts`); a per-driver
   * `driver_profiles.max_concurrent` overrides it.
   *
   * Optional, defaulting to 1 — no stacking, which is the only behaviour the platform currently
   * implements. Validated whenever it *is* set, and bounded at both ends for reasons that are not
   * symmetric: `0` would remove every driver from dispatch and quietly halt all delivery, while an
   * unbounded upper value would have one driver accumulate jobs whose medicines — cold-chain ones
   * included — sit in a bag while they cross the city. A misconfiguration here must fail at boot,
   * not at the first dispatch.
   */
  @IsInt()
  @Min(1)
  @Max(MAX_DELIVERY_MAX_CONCURRENT_JOBS)
  @IsOptional()
  DELIVERY_MAX_CONCURRENT_JOBS: number = DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS;

  /**
   * How many seconds a driver has to answer a job offer (§6.3). Backs
   * `delivery.offerTtlSeconds`.
   *
   * Bounded at both ends because both ends break dispatch in ways nobody would attribute to a
   * config value: a TTL of zero or one second expires every offer before a driver's handset can
   * render it, so no job is ever accepted and every job exhausts its candidates; an unbounded one
   * parks a customer's medicines behind a single unresponsive driver for as long as the number
   * says. Ten minutes is already far past any plausible setting.
   */
  @IsInt()
  @Min(MIN_DELIVERY_OFFER_TTL_SECONDS)
  @Max(MAX_DELIVERY_OFFER_TTL_SECONDS)
  @IsOptional()
  DELIVERY_OFFER_TTL_SECONDS: number = DEFAULT_DELIVERY_OFFER_TTL_SECONDS;

  /** Namespace applied to every Redis key and channel. Backs `redis.keyPrefix`. */
  @IsString()
  @IsOptional()
  REDIS_KEY_PREFIX: string = DEFAULT_REDIS_KEY_PREFIX;

  /**
   * Minimum seconds between durable writes of a driver's position (§7). Backs
   * `delivery.locationWriteIntervalSeconds`.
   *
   * `0` is deliberately legal and means "persist every fix" — the setting a test uses to observe
   * the durable value without waiting. The upper bound exists because this interval is also how
   * stale the position served to a reconnecting customer may be, and five minutes is already far
   * past the point where a live map has stopped being live.
   */
  @IsInt()
  @Min(MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS)
  @Max(MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS)
  @IsOptional()
  DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS: number =
    DEFAULT_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS;

  /**
   * TTL of a job's hot last-known position in Redis. Backs `delivery.locationCacheTtlSeconds`.
   *
   * Floored well above the tracking cadence so the entry cannot expire between two fixes of an
   * active driver, and capped at a day so a cache cannot quietly become a retention store.
   */
  @IsInt()
  @Min(MIN_DELIVERY_LOCATION_CACHE_TTL_SECONDS)
  @Max(MAX_DELIVERY_LOCATION_CACHE_TTL_SECONDS)
  @IsOptional()
  DELIVERY_LOCATION_CACHE_TTL_SECONDS: number = DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS;

  /**
   * How long a computed route may be reused (§7). Backs `delivery.etaCacheTtlSeconds`.
   *
   * Floored so a misconfiguration cannot turn every GPS fix into a routing-provider call, and
   * capped because beyond a few minutes a cached arrival estimate stops describing the journey the
   * driver is actually on.
   */
  @IsInt()
  @Min(MIN_DELIVERY_ETA_CACHE_TTL_SECONDS)
  @Max(MAX_DELIVERY_ETA_CACHE_TTL_SECONDS)
  @IsOptional()
  DELIVERY_ETA_CACHE_TTL_SECONDS: number = DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS;

  /**
   * How far a driver may move before a cached route is recalculated (§5, §10). Backs
   * `delivery.etaRecalculateAfterMeters`.
   *
   * The floor keeps GPS jitter — a stationary handset wandering a few metres — from invalidating
   * the cache on every fix, which would defeat the whole point of having one.
   */
  @IsInt()
  @Min(MIN_DELIVERY_ETA_RECALCULATE_AFTER_METERS)
  @Max(MAX_DELIVERY_ETA_RECALCULATE_AFTER_METERS)
  @IsOptional()
  DELIVERY_ETA_RECALCULATE_AFTER_METERS: number =
    DEFAULT_DELIVERY_ETA_RECALCULATE_AFTER_METERS;

  /**
   * How old the driver's position may be and still support an ETA (§8). Backs
   * `delivery.etaMaxLocationAgeSeconds`.
   *
   * Floored above the posting cadence so an ordinary gap between two fixes cannot suppress every
   * ETA on the platform, and capped so that "stale" remains a meaningful word — an hour-old
   * position supporting a confident arrival time would be worse than no estimate at all.
   */
  @IsInt()
  @Min(MIN_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS)
  @Max(MAX_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS)
  @IsOptional()
  DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS: number =
    DEFAULT_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS;

  /**
   * How much proof every delivery requires (BRULE-29). Backs `delivery.podRequirement`.
   *
   * Validated as an enum so a typo fails at boot rather than silently weakening a compliance rule.
   * That direction matters: a misspelt `CONFIRMATON` falling back to a default would mean an
   * operator believing proof was mandatory while the platform collected none, and nothing would
   * surface the difference until a dispute.
   */
  @IsIn(DELIVERY_POD_REQUIREMENTS)
  @IsOptional()
  DELIVERY_POD_REQUIREMENT: DeliveryPodRequirement = DEFAULT_DELIVERY_POD_REQUIREMENT;

  /** What a cold-chain delivery requires (BRULE-30). Backs `delivery.podColdChainRequirement`. */
  @IsIn(DELIVERY_POD_REQUIREMENTS)
  @IsOptional()
  DELIVERY_POD_COLD_CHAIN_REQUIREMENT: DeliveryPodRequirement =
    DEFAULT_DELIVERY_POD_COLD_CHAIN_REQUIREMENT;

  /** What a cash-on-delivery delivery requires. Backs `delivery.podCodRequirement`. */
  @IsIn(DELIVERY_POD_REQUIREMENTS)
  @IsOptional()
  DELIVERY_POD_COD_REQUIREMENT: DeliveryPodRequirement = DEFAULT_DELIVERY_POD_COD_REQUIREMENT;

  /**
   * Largest accepted proof artifact, in bytes. Backs `delivery.podMaxArtifactBytes`.
   *
   * Capped at 5 MB rather than left open because artifacts arrive base64-encoded in the request
   * body: anything approaching that ceiling needs the framework's body limit raised to match, and
   * an unbounded value here would turn a delivery endpoint into a way to post arbitrary volumes of
   * data at the API. The floor keeps a misconfiguration from rejecting every signature on the
   * platform.
   */
  @IsInt()
  @Min(MIN_DELIVERY_POD_MAX_ARTIFACT_BYTES)
  @Max(MAX_DELIVERY_POD_MAX_ARTIFACT_BYTES)
  @IsOptional()
  DELIVERY_POD_MAX_ARTIFACT_BYTES: number = DEFAULT_DELIVERY_POD_MAX_ARTIFACT_BYTES;

  /**
   * The distance-independent part of the delivery charge, in ETB minor units. Backs
   * `delivery.feeBase`.
   *
   * Validated as a non-negative integer because money on this platform is integer minor units
   * (ADR-005) and a fractional santim cannot be charged, stored or reconciled. The ceiling is far
   * past any real delivery fee and exists so a misplaced decimal point fails at boot rather than
   * appearing on somebody's order.
   */
  @IsInt()
  @Min(MIN_DELIVERY_FEE_AMOUNT)
  @Max(MAX_DELIVERY_FEE_AMOUNT)
  @IsOptional()
  DELIVERY_FEE_BASE: number = DEFAULT_DELIVERY_FEE_BASE;

  /** What each kilometre adds, in minor units. Backs `delivery.feePerKm`. */
  @IsInt()
  @Min(MIN_DELIVERY_FEE_AMOUNT)
  @Max(MAX_DELIVERY_FEE_AMOUNT)
  @IsOptional()
  DELIVERY_FEE_PER_KM: number = DEFAULT_DELIVERY_FEE_PER_KM;

  /** The floor a computed fee is raised to, in minor units. Backs `delivery.feeMinimum`. */
  @IsInt()
  @Min(MIN_DELIVERY_FEE_AMOUNT)
  @Max(MAX_DELIVERY_FEE_AMOUNT)
  @IsOptional()
  DELIVERY_FEE_MINIMUM: number = DEFAULT_DELIVERY_FEE_MINIMUM;

  /** The ceiling a computed fee is capped at, `0` meaning none. Backs `delivery.feeMaximum`. */
  @IsInt()
  @Min(MIN_DELIVERY_FEE_AMOUNT)
  @Max(MAX_DELIVERY_FEE_AMOUNT)
  @IsOptional()
  DELIVERY_FEE_MAXIMUM: number = DEFAULT_DELIVERY_FEE_MAXIMUM;

  /**
   * The minor-unit step a fee is rounded to the nearest of. Backs `delivery.feeRoundTo`.
   *
   * Floored at `1` rather than `0`: a step of zero is not "no rounding", it is a division by zero,
   * and the honest encoding of "round to the santim" is a step of one santim.
   */
  @IsInt()
  @Min(MIN_DELIVERY_FEE_ROUND_TO)
  @Max(MAX_DELIVERY_FEE_ROUND_TO)
  @IsOptional()
  DELIVERY_FEE_ROUND_TO: number = DEFAULT_DELIVERY_FEE_ROUND_TO;

  /** The operator's label for the rate card in force. Backs `delivery.feePricingVersion`. */
  @IsString()
  @IsOptional()
  DELIVERY_FEE_PRICING_VERSION: string = DEFAULT_DELIVERY_FEE_PRICING_VERSION;

  /**
   * The pricing bands, as `id:uptoMeters:feeMinorUnits` triples. Backs `delivery.feeZones`.
   *
   * See `DeliveryFeeZonesConstraint` for why a malformed rate card stops the process rather than
   * quietly becoming no rate card at all.
   */
  @IsString()
  @Validate(DeliveryFeeZonesConstraint)
  @IsOptional()
  DELIVERY_FEE_ZONES: string = DEFAULT_DELIVERY_FEE_ZONES;

  /**
   * The flat amount a driver earns per completed delivery, in ETB minor units. Backs
   * `delivery.earningBase`.
   *
   * A non-negative integer, because money on this platform is integer minor units (ADR-005) and a
   * driver cannot be paid a fraction of a santim. Negative is rejected outright rather than treated
   * as a deduction: a deduction from a driver's pay is a financial operation with its own
   * authorization and dispute questions, and it is not something a rate card should be able to
   * express by accident.
   */
  @IsInt()
  @Min(MIN_DELIVERY_EARNING_AMOUNT)
  @Max(MAX_DELIVERY_EARNING_AMOUNT)
  @IsOptional()
  DELIVERY_EARNING_BASE: number = DEFAULT_DELIVERY_EARNING_BASE;

  /** What each kilometre of the job's frozen distance adds. Backs `delivery.earningPerKm`. */
  @IsInt()
  @Min(MIN_DELIVERY_EARNING_AMOUNT)
  @Max(MAX_DELIVERY_EARNING_AMOUNT)
  @IsOptional()
  DELIVERY_EARNING_PER_KM: number = DEFAULT_DELIVERY_EARNING_PER_KM;

  /**
   * The fraction of the customer's delivery fee passed through to the driver, `0`–`1`. Backs
   * `delivery.earningFeeSharePercent`.
   *
   * Capped at `1`: a share above the whole fee would mean the platform paying out more delivery
   * money than it collected, which may well be a deliberate commercial choice one day but is never
   * something a misplaced decimal point should be able to do silently.
   */
  @IsNumber()
  @Min(MIN_DELIVERY_EARNING_FEE_SHARE_PERCENT)
  @Max(MAX_DELIVERY_EARNING_FEE_SHARE_PERCENT)
  @IsOptional()
  DELIVERY_EARNING_FEE_SHARE_PERCENT: number = DEFAULT_DELIVERY_EARNING_FEE_SHARE_PERCENT;

  /** The guaranteed minimum per delivery. Backs `delivery.earningMinimum`. */
  @IsInt()
  @Min(MIN_DELIVERY_EARNING_AMOUNT)
  @Max(MAX_DELIVERY_EARNING_AMOUNT)
  @IsOptional()
  DELIVERY_EARNING_MINIMUM: number = DEFAULT_DELIVERY_EARNING_MINIMUM;

  /** The cap per delivery, `0` meaning none. Backs `delivery.earningMaximum`. */
  @IsInt()
  @Min(MIN_DELIVERY_EARNING_AMOUNT)
  @Max(MAX_DELIVERY_EARNING_AMOUNT)
  @IsOptional()
  DELIVERY_EARNING_MAXIMUM: number = DEFAULT_DELIVERY_EARNING_MAXIMUM;

  /** The minor-unit step an earning is rounded to. Backs `delivery.earningRoundTo`. */
  @IsInt()
  @Min(MIN_DELIVERY_EARNING_ROUND_TO)
  @Max(MAX_DELIVERY_EARNING_ROUND_TO)
  @IsOptional()
  DELIVERY_EARNING_ROUND_TO: number = DEFAULT_DELIVERY_EARNING_ROUND_TO;

  /** The operator's label for the earning agreement in force. Backs `delivery.earningVersion`. */
  @IsString()
  @IsOptional()
  DELIVERY_EARNING_VERSION: string = DEFAULT_DELIVERY_EARNING_VERSION;

  /**
   * Whether a COD collection must match the order total exactly. Backs
   * `delivery.codRequireExactAmount`.
   *
   * Parsed as a string rather than declared `boolean` because `enableImplicitConversion` turns any
   * non-empty string into `true` — including `"false"`, which is precisely the value an operator
   * would write to switch this *off*. `readCodRequireExactAmount` does the comparison instead, so
   * the only value that enables the rule is a literal `true`.
   */
  @IsIn(['true', 'false'])
  @IsOptional()
  DELIVERY_COD_REQUIRE_EXACT_AMOUNT: string = String(
    DEFAULT_DELIVERY_COD_REQUIRE_EXACT_AMOUNT,
  );

  /**
   * Whether a COD delivery needs a recorded collection before `COMPLETED`. Backs
   * `delivery.codRequireCollectionForCompletion`.
   *
   * Same string handling, and the same reason. See the config default for why this applies to every
   * delivery on the platform and therefore ships switched off.
   */
  @IsIn(['true', 'false'])
  @IsOptional()
  DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION: string = String(
    DEFAULT_DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION,
  );

  /**
   * The most rows one background-recovery tick may process. Backs `delivery.recoveryBatchSize`.
   *
   * Bounded below at one because a batch of zero is a worker that runs forever and does nothing —
   * the most confusing way to disable something, and not how anything else here is disabled. The
   * ceiling keeps a tick a bounded unit of work; see the constant's note.
   */
  @IsInt()
  @Min(MIN_DELIVERY_RECOVERY_BATCH_SIZE)
  @Max(MAX_DELIVERY_RECOVERY_BATCH_SIZE)
  @IsOptional()
  DELIVERY_RECOVERY_BATCH_SIZE: number = DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE;

  /**
   * How long a job wanting a driver must sit untouched before recovery treats it as stalled. Backs
   * `delivery.recoveryQuietSeconds`.
   *
   * `0` is legal and means "recover immediately", which is what the e2e suite uses to observe a
   * recovery without waiting a minute for it. It is not a production setting: at zero the worker
   * contends with dispatch's own two-transaction reassignment window, which resolves correctly
   * through the partial unique index but does redundant work to get there.
   */
  @IsInt()
  @Min(MIN_DELIVERY_RECOVERY_QUIET_SECONDS)
  @Max(MAX_DELIVERY_RECOVERY_QUIET_SECONDS)
  @IsOptional()
  DELIVERY_RECOVERY_QUIET_SECONDS: number = DEFAULT_DELIVERY_RECOVERY_QUIET_SECONDS;

  /**
   * How long a pre-pickup job may sit with a driver who has stopped working before it is
   * reassigned. Backs `delivery.staleAssignmentSeconds`.
   *
   * Bounded above at a day rather than left open because this setting *takes a job away from a
   * named driver*, and a typo that reads as "never" would silently switch off the recovery §11.5
   * requires while leaving a worker running that appears to provide it.
   */
  @IsInt()
  @Min(MIN_DELIVERY_STALE_ASSIGNMENT_SECONDS)
  @Max(MAX_DELIVERY_STALE_ASSIGNMENT_SECONDS)
  @IsOptional()
  DELIVERY_STALE_ASSIGNMENT_SECONDS: number = DEFAULT_DELIVERY_STALE_ASSIGNMENT_SECONDS;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return validated;
}
