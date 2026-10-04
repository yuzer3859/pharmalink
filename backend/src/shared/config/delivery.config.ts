import { registerAs } from '@nestjs/config';

/**
 * The environment variable backing `delivery.maxConcurrentJobs`.
 *
 * Named to match the dotted config key its readers use, so the two are findable from each other —
 * the convention `orders.config.ts` established.
 */
export const DELIVERY_MAX_CONCURRENT_JOBS_ENV = 'DELIVERY_MAX_CONCURRENT_JOBS';

/**
 * How many jobs one driver may hold at once when nothing is configured (BRULE-28).
 *
 * **One, deliberately.** Stacked deliveries are §3.2 F-JOB-06, marked "optional/future" by the
 * design and unbuilt: nothing computes a combined route, nothing sequences two dropoffs, and
 * nothing separates two customers' bags. A default above one would silently switch on a feature
 * that does not exist, and the failure would be a driver holding two orders with no idea which
 * goes where.
 *
 * It is also the conservative direction. Too low means a driver finishes one delivery before
 * starting the next — slower, and visible. Too high means medicines sitting in a bag while the
 * driver crosses the city for someone else, which for a cold-chain item (BRULE-30) is a safety
 * problem nobody would see until it had happened.
 *
 * `driver_profiles.max_concurrent` overrides this per driver. Raising it for everyone is a config
 * change once the stacking work exists.
 */
export const DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS = 1;

/** The ceiling `env.validation.ts` enforces. See the default's note on stacked deliveries. */
export const MAX_DELIVERY_MAX_CONCURRENT_JOBS = 10;

/** Parses the env value, falling back to the default when unset or blank. */
export function readMaxConcurrentJobs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_MAX_CONCURRENT_JOBS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_MAX_CONCURRENT_JOBS;
  }
  return Number(raw);
}

/**
 * The `delivery` configuration namespace.
 *
 * `delivery.maxConcurrentJobs` is one of the five keys `00-shared-conventions.md` §10 names
 * outright as an example of a config-driven tunable, and §3.1 F-DRV-04 requires the concurrent
 * limit to be "configurable". This is the source that makes the dotted key resolve: `ConfigService`
 * has no value for a dotted key unless a `load` factory registers it, so without this the readers
 * would fall through to their defaults no matter what an operator set — the exact gap
 * `orders.config.ts` was written to close for `orders.platformFeePercent`.
 *
 * Validation lives in `env.validation.ts` alongside every other variable the app reads, so an
 * out-of-range limit fails at boot rather than at the first dispatch.
 */
export const DELIVERY_OFFER_TTL_SECONDS_ENV = 'DELIVERY_OFFER_TTL_SECONDS';

/**
 * How long a driver has to answer a job offer before it expires (§3.2 F-JOB-04, §6.3).
 *
 * **Thirty seconds, which is the design's own worked example** ("a `JobOffer` with **TTL** (e.g.,
 * 30s)"). The number is a trade between two real costs and neither direction is free: too short
 * and a driver riding through traffic loses offers they would have taken, which reads to them as
 * the platform not giving them work; too long and a customer's medicines sit at a pharmacy while
 * dispatch waits on somebody who put their phone down.
 *
 * It is a *floor* on how fast a job can move to the next candidate, not a promise about how fast
 * it will: expiry is evaluated against the stored `expires_at` whenever the offer is read, so an
 * offer is retired the moment anybody looks at it after its deadline.
 */
export const DEFAULT_DELIVERY_OFFER_TTL_SECONDS = 30;

/** Bounds enforced in `env.validation.ts`. See `readOfferTtlSeconds` for why each end exists. */
export const MIN_DELIVERY_OFFER_TTL_SECONDS = 5;
export const MAX_DELIVERY_OFFER_TTL_SECONDS = 600;

/** Parses the env value, falling back to the default when unset or blank. */
export function readOfferTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_OFFER_TTL_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_OFFER_TTL_SECONDS;
  }
  return Number(raw);
}

export const DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS_ENV =
  'DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS';

/**
 * The minimum gap between two durable writes of one driver's position (§7, NFR-PERF-04).
 *
 * **Ten seconds, which is NFR-PERF-04's own number**, and it is chosen from the side that
 * matters. The customer's live map is fed by pub/sub and is not throttled at all -- every accepted
 * fix is fanned out the moment it arrives. What this interval governs is how far behind
 * `driver_profiles.last_location_at` is allowed to fall, and the reason that has a ceiling is
 * reconnection: a customer whose phone drops off the network is served the *durable* position
 * when they come back, so an interval above the tracking target would show them a position the
 * platform already knew was out of date.
 *
 * The design's instruction is to avoid write amplification ("location is not persisted per-tick"),
 * not to avoid persistence. A driver app posting every three seconds writes three rows a minute
 * instead of twenty, and the position a dispute or a dispatch decision reads is still within the
 * tracking target.
 *
 * Zero disables throttling and writes every fix, which is the right setting for a test that wants
 * to observe the durable value directly.
 */
export const DEFAULT_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS = 10;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS = 0;
export const MAX_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS = 300;

/** Parses the env value, falling back to the default when unset or blank. */
export function readLocationWriteIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_LOCATION_WRITE_INTERVAL_SECONDS;
  }
  return Number(raw);
}

export const DELIVERY_LOCATION_CACHE_TTL_SECONDS_ENV = 'DELIVERY_LOCATION_CACHE_TTL_SECONDS';

/**
 * How long a job's hot last-known position survives in Redis without a refresh (§7's "hot, TTL").
 *
 * **Fifteen minutes.** The entry exists to answer two questions quickly -- "where is this driver
 * now?" for a subscribing customer, and "is this fix newer than the one I already have?" for the
 * ordering guard -- and both stop being useful long before a delivery ends. A TTL that outlived
 * the job would leave a stale coordinate in the cache for a job that has since been reassigned to
 * somebody else.
 *
 * It is a cache expiry, not a retention policy: the durable answer is in `driver_profiles` and
 * outlives this entry by definition, so an expired key costs one Postgres read, never a fact.
 */
export const DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS = 900;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_LOCATION_CACHE_TTL_SECONDS = 30;
export const MAX_DELIVERY_LOCATION_CACHE_TTL_SECONDS = 86_400;

/** Parses the env value, falling back to the default when unset or blank. */
export function readLocationCacheTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_LOCATION_CACHE_TTL_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_LOCATION_CACHE_TTL_SECONDS;
  }
  return Number(raw);
}

export const DELIVERY_ETA_CACHE_TTL_SECONDS_ENV = 'DELIVERY_ETA_CACHE_TTL_SECONDS';

/**
 * How long a computed route may be reused before it is recalculated (§7's "cached and refreshed").
 *
 * **Thirty seconds.** This is the *time* half of the reuse rule; `etaRecalculateAfterMeters` below
 * is the *distance* half, and an entry has to satisfy both. The two exist because an ETA can go
 * wrong in two unrelated ways: the driver moves, or the roads do. Distance catches the first.
 * This catches the second — traffic building on a route the driver has not yet left, a provider
 * revising its estimate — and it is what stops a stationary driver's ETA from being frozen
 * indefinitely by the distance check alone.
 *
 * Deliberately longer than NFR-PERF-04's ten-second tracking target, which is not a contradiction:
 * the target governs how often a customer sees the driver *move*, and positions are fanned out
 * unthrottled on every fix. An arrival estimate recomputed three times a minute while the marker
 * updates continuously is the right trade, and the alternative is a provider round-trip on every
 * GPS tick from every driver on the platform.
 */
export const DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS = 30;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_ETA_CACHE_TTL_SECONDS = 5;
export const MAX_DELIVERY_ETA_CACHE_TTL_SECONDS = 600;

/** Parses the env value, falling back to the default when unset or blank. */
export function readEtaCacheTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_ETA_CACHE_TTL_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_ETA_CACHE_TTL_SECONDS;
  }
  return Number(raw);
}

export const DELIVERY_ETA_RECALCULATE_AFTER_METERS_ENV =
  'DELIVERY_ETA_RECALCULATE_AFTER_METERS';

/**
 * How far a driver may move before a cached route stops being reusable (§5, §10).
 *
 * **A hundred and fifty metres**, which is roughly a city block and about eighteen seconds at
 * urban motorcycle speed. The number is picked from what a customer would notice: below it, the
 * arrival estimate a reused route produces differs from a fresh one by a few seconds, which is
 * well inside the error of any traffic model. Above it the driver may have turned, taken a
 * different road, or cleared the junction that the old estimate was still counting.
 *
 * It also does the job §5 asks of it directly — "avoid calling the routing provider unnecessarily
 * for identical/stale coordinates". A stationary driver waiting at a pharmacy produces identical
 * coordinates fix after fix and triggers no route calls at all.
 */
export const DEFAULT_DELIVERY_ETA_RECALCULATE_AFTER_METERS = 150;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_ETA_RECALCULATE_AFTER_METERS = 10;
export const MAX_DELIVERY_ETA_RECALCULATE_AFTER_METERS = 5_000;

/** Parses the env value, falling back to the default when unset or blank. */
export function readEtaRecalculateAfterMeters(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_ETA_RECALCULATE_AFTER_METERS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_ETA_RECALCULATE_AFTER_METERS;
  }
  return Number(raw);
}

export const DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS_ENV =
  'DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS';

/**
 * How old the driver's last position may be and still support an arrival estimate (§8).
 *
 * **Two minutes.** An ETA is a claim about where somebody is *now*; computed from a position taken
 * five minutes ago it is not an estimate at all, it is arithmetic on a place the driver has left.
 * NFR-LOC-04 guarantees this case will happen — handsets lose signal in traffic and in
 * basements — so the platform has to decide what to say, and the honest answer is nothing.
 *
 * Past this age the last-known position is still returned (a customer watching a marker that has
 * not moved for three minutes is being told the truth), and the ETA is simply absent. What it
 * deliberately does **not** do is turn into a customer-visible "driver offline" state: the
 * platform knows it has not heard from the handset, which is not the same fact, and the tracking
 * work declined to invent that status for the same reason.
 *
 * Generous relative to the ten-second posting cadence, because the cost of the two errors is not
 * symmetric. Suppressing a good ETA briefly is a small disappointment; showing a confident wrong
 * one sends a customer to their door for a driver who is nowhere near it.
 */
export const DEFAULT_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS = 120;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS = 15;
export const MAX_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS = 3_600;

/** Parses the env value, falling back to the default when unset or blank. */
export function readEtaMaxLocationAgeSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_ETA_MAX_LOCATION_AGE_SECONDS;
  }
  return Number(raw);
}

export const DELIVERY_POD_REQUIREMENT_ENV = 'DELIVERY_POD_REQUIREMENT';
export const DELIVERY_POD_COLD_CHAIN_REQUIREMENT_ENV = 'DELIVERY_POD_COLD_CHAIN_REQUIREMENT';
export const DELIVERY_POD_COD_REQUIREMENT_ENV = 'DELIVERY_POD_COD_REQUIREMENT';

/**
 * The proof-of-delivery requirement levels, as an operator sets them.
 *
 * Mirrors `PodRequirement` in the domain rather than importing it: `env.validation.ts` and this
 * file are shared infrastructure and must not depend on a feature module's domain layer, which is
 * the same separation `orders.config.ts` keeps. The delivery module maps one to the other, and a
 * unit test asserts the two lists agree so they cannot drift apart silently.
 */
export const DELIVERY_POD_REQUIREMENTS = ['NONE', 'CONFIRMATION', 'ARTIFACT'] as const;
export type DeliveryPodRequirement = (typeof DELIVERY_POD_REQUIREMENTS)[number];

/**
 * How much proof every delivery needs (BR-DEL-06, BRULE-29).
 *
 * **`NONE`, and that is a considered position rather than a placeholder.** BRULE-29 requires proof
 * "where policy mandates it", and no policy mandates any yet: the design lists this first under
 * *Open Questions for Product/Compliance* — "which orders require photo/signature vs simple
 * confirmation? Controlled/cold-chain always photo?" — which is a question for a pharmacist and a
 * regulator to answer.
 *
 * So the machinery is complete and the mandate is empty. Setting this to `CONFIRMATION` or
 * `ARTIFACT` turns it on across the platform with no code change and no deployment beyond the
 * variable itself.
 *
 * Defaulting to `CONFIRMATION` was the tempting alternative, and it would have been wrong twice
 * over: it is a delivery policy nobody approved, and it would have changed the behaviour of every
 * delivery already flowing through the platform — a customer who was out when their order arrived
 * would suddenly find the driver unable to complete a delivery that had been completable the day
 * before. A rule that appears by default is a rule nobody chose.
 */
export const DEFAULT_DELIVERY_POD_REQUIREMENT: DeliveryPodRequirement = 'NONE';

/**
 * What a cold-chain delivery requires (BRULE-30), when that should be stricter than the base.
 *
 * Its own knob because the design's open question names cold-chain specifically — "Controlled/
 * cold-chain always photo?" — and because BRULE-30 already singles these deliveries out for
 * special handling. It defaults to `NONE` for the same reason the base does: the question is asked
 * in the design and not answered, and answering it here would be this module inventing a
 * handling requirement for temperature-sensitive medicines on a compliance team's behalf.
 *
 * The strictest applicable rule wins, so raising this alone tightens cold-chain deliveries and
 * leaves everything else untouched.
 */
export const DEFAULT_DELIVERY_POD_COLD_CHAIN_REQUIREMENT: DeliveryPodRequirement = 'NONE';

/**
 * What a cash-on-delivery delivery requires, when that should be stricter than the base.
 *
 * Cash changing hands at a doorstep is the classic reason to want a signature, and an operator may
 * well decide that before they decide anything about medicines. Its own knob so they can, and
 * `NONE` by default so the platform asserts nothing on their behalf.
 */
export const DEFAULT_DELIVERY_POD_COD_REQUIREMENT: DeliveryPodRequirement = 'NONE';

function readPodRequirement(
  envKey: string,
  fallback: DeliveryPodRequirement,
  env: NodeJS.ProcessEnv,
): DeliveryPodRequirement {
  const raw = env[envKey];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  const value = String(raw).trim().toUpperCase();
  return (DELIVERY_POD_REQUIREMENTS as readonly string[]).includes(value)
    ? (value as DeliveryPodRequirement)
    : fallback;
}

export function readPodBaseRequirement(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryPodRequirement {
  return readPodRequirement(
    DELIVERY_POD_REQUIREMENT_ENV,
    DEFAULT_DELIVERY_POD_REQUIREMENT,
    env,
  );
}

export function readPodColdChainRequirement(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryPodRequirement {
  return readPodRequirement(
    DELIVERY_POD_COLD_CHAIN_REQUIREMENT_ENV,
    DEFAULT_DELIVERY_POD_COLD_CHAIN_REQUIREMENT,
    env,
  );
}

export function readPodCodRequirement(
  env: NodeJS.ProcessEnv = process.env,
): DeliveryPodRequirement {
  return readPodRequirement(
    DELIVERY_POD_COD_REQUIREMENT_ENV,
    DEFAULT_DELIVERY_POD_COD_REQUIREMENT,
    env,
  );
}

export const DELIVERY_POD_MAX_ARTIFACT_BYTES_ENV = 'DELIVERY_POD_MAX_ARTIFACT_BYTES';

/**
 * The largest proof artifact this platform will accept, in bytes.
 *
 * **48 KiB, and the number is set by a constraint rather than by taste.** Artifacts arrive
 * base64-encoded inside the JSON request body, and Express's default body limit is 100 KB; base64
 * inflates bytes by about a third, so 48 KiB of image becomes roughly 64 KB of request and leaves
 * comfortable headroom for the rest of the payload. Raising this without also raising the body
 * limit would produce a `413` from the framework instead of this module's own clear refusal, which
 * is a worse failure for a driver standing at a door.
 *
 * That is small for a photograph and entirely adequate for a signature. It is an honest reflection
 * of where the platform is: with no object-storage provider approved, bytes have to pass through
 * the API, and passing megabytes through an API is the wrong shape. The right shape — a presigned
 * upload straight to storage, with this service only ever seeing the handle — is what Module 01's
 * verification documents already assume and what the work that chooses a provider should build.
 */
export const DEFAULT_DELIVERY_POD_MAX_ARTIFACT_BYTES = 49_152;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_POD_MAX_ARTIFACT_BYTES = 1_024;
export const MAX_DELIVERY_POD_MAX_ARTIFACT_BYTES = 5_242_880;

/** Parses the env value, falling back to the default when unset or blank. */
export function readPodMaxArtifactBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_POD_MAX_ARTIFACT_BYTES_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_POD_MAX_ARTIFACT_BYTES;
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// Delivery fee (F-FEE-01, BR-DEL-09) — the customer's delivery charge.
// ---------------------------------------------------------------------------
//
// **Every default below is zero or empty, and that is the whole point.** The design's own Open
// Question 3 — "Delivery fee model — flat/zone/distance (FR-DEL-09) — must align with Module 6
// `PricingCalculator` and Module 7 accounting" — is unresolved, so there is no approved rate card
// to encode. Shipping a made-up base fee and a made-up per-kilometre rate would start charging
// real customers real money nobody signed off, and it would do so quietly, because a delivery fee
// is a line on a total rather than a feature somebody switches on.
//
// So the machinery is complete and the rate card is empty: with these defaults every quote is
// `0`, which is exactly what the platform charges today — `orders.deliveryFeeFlat` was never
// registered in any `registerAs` namespace, so it has always resolved to `undefined` and fallen
// through to its `?? 0`. Turning pricing on is configuration, not a deployment. That is the same
// position `DEFAULT_DELIVERY_POD_REQUIREMENT` takes on proof and `DEFAULT_ORDERS_PLATFORM_FEE_PERCENT`
// takes on commission, and for the same reason: a charge that appears by default is a charge
// nobody chose.

export const DELIVERY_FEE_BASE_ENV = 'DELIVERY_FEE_BASE';

/**
 * The distance-independent part of a delivery charge, in ETB minor units (santim, ADR-005).
 *
 * Zero by default — see the block comment above. Set alongside `DELIVERY_FEE_PER_KM` to price
 * deliveries as `base + rate × distance`.
 */
export const DEFAULT_DELIVERY_FEE_BASE = 0;

export const DELIVERY_FEE_PER_KM_ENV = 'DELIVERY_FEE_PER_KM';

/** What each kilometre of routed distance adds, in minor units. Zero by default. */
export const DEFAULT_DELIVERY_FEE_PER_KM = 0;

export const DELIVERY_FEE_MINIMUM_ENV = 'DELIVERY_FEE_MINIMUM';

/**
 * The floor a computed fee is raised to, in minor units.
 *
 * Applied **after** rounding, so the floor is a guarantee rather than a suggestion: an operator
 * who sets a minimum of 2000 gets 2000, whatever the rounding step would otherwise have done to
 * it. Zero by default, which is no floor at all.
 */
export const DEFAULT_DELIVERY_FEE_MINIMUM = 0;

export const DELIVERY_FEE_MAXIMUM_ENV = 'DELIVERY_FEE_MAXIMUM';

/**
 * The ceiling a computed fee is capped at, in minor units. `0` means **no ceiling**.
 *
 * Zero-as-absent rather than a nullable variable, because an unset variable already means "use
 * the default": a literal cap of zero would be a rate card that charges nothing for delivery
 * however far it goes, which is not a cap anybody sets on purpose.
 */
export const DEFAULT_DELIVERY_FEE_MAXIMUM = 0;

export const DELIVERY_FEE_ROUND_TO_ENV = 'DELIVERY_FEE_ROUND_TO';

/**
 * The minor-unit step a computed fee is rounded to the nearest of. `1` rounds to the santim.
 *
 * Exists because a per-kilometre rate produces amounts like `1847` that no pharmacy would print
 * on a receipt; an operator pricing in whole birr sets `100`. The rounding itself is `Math.round`,
 * the convention `PricingCalculator.computeTotals` already uses for the platform fee — applied
 * once, at the end, never carried forward as a fraction.
 */
export const DEFAULT_DELIVERY_FEE_ROUND_TO = 1;

/** Bounds enforced in `env.validation.ts`. A hundred thousand birr is far past any real fee. */
export const MIN_DELIVERY_FEE_AMOUNT = 0;
export const MAX_DELIVERY_FEE_AMOUNT = 10_000_000;
export const MIN_DELIVERY_FEE_ROUND_TO = 1;
export const MAX_DELIVERY_FEE_ROUND_TO = 10_000;

export const DELIVERY_FEE_PRICING_VERSION_ENV = 'DELIVERY_FEE_PRICING_VERSION';

/**
 * The label an operator gives the rate card currently in force.
 *
 * Carried on every quote and recorded in the delivery job's creation audit entry, so a fee charged
 * months ago can be explained by naming the price list that produced it rather than inferred from
 * whatever the configuration happens to say today.
 *
 * **Operator-managed on purpose.** Deriving it from a hash of the settings would make it change on
 * every unrelated tweak and mean nothing to the person reading it, and the question a dispute
 * actually asks — "which price list was in force?" — only a human can name.
 *
 * `v1` by default: the empty rate card described above.
 */
export const DEFAULT_DELIVERY_FEE_PRICING_VERSION = 'v1';

export const DELIVERY_FEE_ZONES_ENV = 'DELIVERY_FEE_ZONES';

/**
 * The configured pricing zones, as an operator writes them.
 *
 * Format: comma-separated `id:uptoMeters:feeMinorUnits` triples —
 * `inner:3000:2000,middle:8000:3500,outer:15000:5000`. A zone matches when the **routed** distance
 * is at or below its `uptoMeters`; the nearest matching band wins and its flat fee is the charge.
 *
 * ## Why distance bands rather than geography
 *
 * BR-DEL-09 says fees are "calculated by distance/zone" and never says what a zone is. Nothing in
 * the repository answers that either: Module 04's `service_zones` addresses a different question
 * entirely — whether a branch *serves* a point — and carries no rate at all. So this work
 * implements the smallest thing that is genuinely zone-shaped: a named band around the pickup
 * branch with its own flat price, which is how courier and ride-hailing pricing in Addis is
 * actually quoted, and which needs no spatial index, no polygon library and no migration.
 *
 * **The extension point is `DeliveryFeePolicy`'s matched zone, not this string.** Real geographic
 * zones — a `delivery_fee_zones` table of polygons resolved by a point-in-polygon lookup — would
 * replace how a zone is *selected* and change nothing about how it is *priced*: the policy already
 * takes a matched band and returns its fee, and every quote already reports which zone it used.
 * That is the seam a later work extends.
 *
 * Empty by default, so every quote falls through to the distance basis. See the block comment
 * above for why nothing here ships with a price.
 */
export const DEFAULT_DELIVERY_FEE_ZONES = '';

/** One configured pricing band. `uptoMeters` is inclusive; `fee` is ETB minor units. */
export interface DeliveryFeeZoneSetting {
  id: string;
  uptoMeters: number;
  fee: number;
}

/**
 * Parses `DELIVERY_FEE_ZONES`, returning the bands in ascending `uptoMeters` order.
 *
 * Malformed entries are **dropped rather than guessed at**, and `env.validation.ts` refuses a
 * malformed string at boot, so dropping can only ever happen to a configuration this process
 * never accepted. Sorting here rather than trusting the operator's ordering makes "nearest
 * matching band wins" a property of the data instead of a property of how carefully the variable
 * was typed.
 */
export function parseDeliveryFeeZones(raw: string): DeliveryFeeZoneSetting[] {
  const zones: DeliveryFeeZoneSetting[] = [];
  for (const entry of String(raw ?? '').split(',')) {
    const text = entry.trim();
    if (text === '') {
      continue;
    }
    const parts = text.split(':');
    if (parts.length !== 3) {
      continue;
    }
    const id = parts[0].trim();
    const uptoMeters = Number(parts[1]);
    const fee = Number(parts[2]);
    if (
      id === '' ||
      !Number.isInteger(uptoMeters) ||
      uptoMeters <= 0 ||
      !Number.isInteger(fee) ||
      fee < 0 ||
      fee > MAX_DELIVERY_FEE_AMOUNT
    ) {
      continue;
    }
    zones.push({ id, uptoMeters, fee });
  }
  return zones.sort((a, b) => a.uptoMeters - b.uptoMeters);
}

/** Whether every non-empty entry in a `DELIVERY_FEE_ZONES` string is well-formed. */
export function isValidDeliveryFeeZones(raw: string): boolean {
  const entries = String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.length === parseDeliveryFeeZones(raw).length;
}

function readFeeAmount(envKey: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[envKey];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  return Number(raw);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readFeeBase(env: NodeJS.ProcessEnv = process.env): number {
  return readFeeAmount(DELIVERY_FEE_BASE_ENV, DEFAULT_DELIVERY_FEE_BASE, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readFeePerKm(env: NodeJS.ProcessEnv = process.env): number {
  return readFeeAmount(DELIVERY_FEE_PER_KM_ENV, DEFAULT_DELIVERY_FEE_PER_KM, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readFeeMinimum(env: NodeJS.ProcessEnv = process.env): number {
  return readFeeAmount(DELIVERY_FEE_MINIMUM_ENV, DEFAULT_DELIVERY_FEE_MINIMUM, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readFeeMaximum(env: NodeJS.ProcessEnv = process.env): number {
  return readFeeAmount(DELIVERY_FEE_MAXIMUM_ENV, DEFAULT_DELIVERY_FEE_MAXIMUM, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readFeeRoundTo(env: NodeJS.ProcessEnv = process.env): number {
  return readFeeAmount(DELIVERY_FEE_ROUND_TO_ENV, DEFAULT_DELIVERY_FEE_ROUND_TO, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readFeePricingVersion(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[DELIVERY_FEE_PRICING_VERSION_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_FEE_PRICING_VERSION;
  }
  return String(raw).trim();
}

/** Parses the env value, falling back to the default (no zones) when unset or blank. */
export function readFeeZones(env: NodeJS.ProcessEnv = process.env): DeliveryFeeZoneSetting[] {
  return parseDeliveryFeeZones(env[DELIVERY_FEE_ZONES_ENV] ?? DEFAULT_DELIVERY_FEE_ZONES);
}

// ---------------------------------------------------------------------------
// Driver earnings (F-ERN-01, BR-DEL-10) — what a driver is paid for a delivery.
// ---------------------------------------------------------------------------
//
// **Every default is zero, and here that is not merely conservative — it is the only honest
// setting available.** The design's Open Question 4 is still open, and it is the whole question:
// "Driver earnings model — base + per-km + incentives; **who funds it (platform vs delivery fee
// split)?**" Nobody has decided whether a driver is paid out of the customer's delivery fee, out
// of platform margin, or from some split of the two, and there is no rate card anywhere in this
// repository to encode.
//
// A non-zero default here would not be a placeholder. It would be the platform quietly committing
// to pay drivers an amount nobody agreed, on a funding model nobody chose, accruing a real
// liability on every completed delivery — and it would do so invisibly, because an earning accrues
// in the background rather than in front of anybody.
//
// So the machinery is complete and the rate card is empty: with these defaults every completed
// delivery accrues an earning of **zero**, which is a truthful record that the delivery happened
// and that no rate had yet been agreed for it. Turning payment on is configuration, not a
// deployment — the same position `delivery.fee*` takes on the customer charge and
// `delivery.podRequirement` takes on proof.
//
// What remains a product decision, stated plainly so the next work does not have to infer it:
//
//  - the funding model (platform-funded, fee-split, or a mix) — Open Question 4;
//  - the actual rates (`DELIVERY_EARNING_BASE`, `_PER_KM`, `_FEE_SHARE_PERCENT`);
//  - incentive and surge rules, which have no inputs on this platform at all (no ratings feed
//    delivery, no surge signal exists) and which is why `incentive` is a recorded component with
//    no knob — see `DriverEarningPolicy`;
//  - tax and withholding, which nothing in this repository models;
//  - payout cadence and mechanism, which are Module 07's settlement work, not Delivery's.

export const DELIVERY_EARNING_BASE_ENV = 'DELIVERY_EARNING_BASE';

/**
 * The flat amount a driver earns for completing a delivery, in ETB minor units (santim, ADR-005).
 *
 * Zero by default — see the block comment above.
 */
export const DEFAULT_DELIVERY_EARNING_BASE = 0;

export const DELIVERY_EARNING_PER_KM_ENV = 'DELIVERY_EARNING_PER_KM';

/**
 * What each kilometre of the delivery's **frozen** distance adds, in minor units.
 *
 * The distance is `delivery_jobs.distanceMeters`, recorded when the job was cut (Work 09) — never
 * re-measured at accrual time. See `DriverEarningPolicy` for what happens when a job has none.
 */
export const DEFAULT_DELIVERY_EARNING_PER_KM = 0;

export const DELIVERY_EARNING_FEE_SHARE_PERCENT_ENV = 'DELIVERY_EARNING_FEE_SHARE_PERCENT';

/**
 * The share of the customer's delivery fee that passes through to the driver, as a fraction
 * (`0.7` means 70%).
 *
 * **This knob is the funding question, and it is switched off.** Zero means the driver's earning
 * is computed entirely from the base and distance rates above and has *no* arithmetic relationship
 * to what the customer paid — which is the correct default precisely because the relationship is
 * undecided. Setting it above zero is a deliberate statement that the delivery fee funds the
 * driver, which is half of Open Question 4 answered.
 *
 * It reads `delivery_jobs.deliveryFee` — the amount Module 06 froze and the customer actually
 * paid — never today's rate card. An earning accrued months from now reports the share of the fee
 * that was really charged.
 *
 * Expressed as a fraction rather than basis points to match `orders.platformFeePercent`, the
 * platform's existing percentage convention.
 */
export const DEFAULT_DELIVERY_EARNING_FEE_SHARE_PERCENT = 0;

export const DELIVERY_EARNING_MINIMUM_ENV = 'DELIVERY_EARNING_MINIMUM';

/**
 * The floor an accrued earning is raised to, in minor units — a guaranteed minimum per delivery.
 *
 * Applied after rounding, so the guarantee is a guarantee. Zero by default, which is no floor.
 */
export const DEFAULT_DELIVERY_EARNING_MINIMUM = 0;

export const DELIVERY_EARNING_MAXIMUM_ENV = 'DELIVERY_EARNING_MAXIMUM';

/**
 * The ceiling an accrued earning is capped at, in minor units. `0` means **no ceiling**.
 *
 * Zero-as-absent for the reason `DEFAULT_DELIVERY_FEE_MAXIMUM` gives: an unset variable already
 * means "use the default", so a literal cap of zero would be a rate card that pays nothing however
 * far the driver rode.
 */
export const DEFAULT_DELIVERY_EARNING_MAXIMUM = 0;

export const DELIVERY_EARNING_ROUND_TO_ENV = 'DELIVERY_EARNING_ROUND_TO';

/**
 * The minor-unit step an earning is rounded to the nearest of. `1` rounds to the santim.
 *
 * `Math.round`, the convention `PricingCalculator` and `DeliveryFeePolicy` already share.
 */
export const DEFAULT_DELIVERY_EARNING_ROUND_TO = 1;

/** Bounds enforced in `env.validation.ts`. */
export const MIN_DELIVERY_EARNING_AMOUNT = 0;
export const MAX_DELIVERY_EARNING_AMOUNT = 10_000_000;
export const MIN_DELIVERY_EARNING_ROUND_TO = 1;
export const MAX_DELIVERY_EARNING_ROUND_TO = 10_000;
export const MIN_DELIVERY_EARNING_FEE_SHARE_PERCENT = 0;
export const MAX_DELIVERY_EARNING_FEE_SHARE_PERCENT = 1;

export const DELIVERY_EARNING_VERSION_ENV = 'DELIVERY_EARNING_VERSION';

/**
 * The operator's label for the earning rate card in force.
 *
 * Stamped onto every accrued earning and carried on the `EarningAccrued` event, so a settlement
 * run months later can say which agreement an amount was computed under rather than inferring it
 * from whatever the configuration happens to say that day. Deliberately **separate from
 * `delivery.feePricingVersion`**: what the customer is charged and what the driver is paid are two
 * agreements with two different counterparties, and versioning them together would mean a change
 * to one silently relabelling the other.
 *
 * Operator-managed, for the reason `DEFAULT_DELIVERY_FEE_PRICING_VERSION` sets out.
 */
export const DEFAULT_DELIVERY_EARNING_VERSION = 'v1';

function readEarningAmount(envKey: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[envKey];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  return Number(raw);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningBase(env: NodeJS.ProcessEnv = process.env): number {
  return readEarningAmount(DELIVERY_EARNING_BASE_ENV, DEFAULT_DELIVERY_EARNING_BASE, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningPerKm(env: NodeJS.ProcessEnv = process.env): number {
  return readEarningAmount(DELIVERY_EARNING_PER_KM_ENV, DEFAULT_DELIVERY_EARNING_PER_KM, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningFeeSharePercent(env: NodeJS.ProcessEnv = process.env): number {
  return readEarningAmount(
    DELIVERY_EARNING_FEE_SHARE_PERCENT_ENV,
    DEFAULT_DELIVERY_EARNING_FEE_SHARE_PERCENT,
    env,
  );
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningMinimum(env: NodeJS.ProcessEnv = process.env): number {
  return readEarningAmount(DELIVERY_EARNING_MINIMUM_ENV, DEFAULT_DELIVERY_EARNING_MINIMUM, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningMaximum(env: NodeJS.ProcessEnv = process.env): number {
  return readEarningAmount(DELIVERY_EARNING_MAXIMUM_ENV, DEFAULT_DELIVERY_EARNING_MAXIMUM, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningRoundTo(env: NodeJS.ProcessEnv = process.env): number {
  return readEarningAmount(DELIVERY_EARNING_ROUND_TO_ENV, DEFAULT_DELIVERY_EARNING_ROUND_TO, env);
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readEarningVersion(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[DELIVERY_EARNING_VERSION_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_EARNING_VERSION;
  }
  return String(raw).trim();
}

// ---------------------------------------------------------------------------
// Cash on delivery (F-COD-01, BR-DEL-10) — recording what the driver collected.
// ---------------------------------------------------------------------------
//
// Both rules below are **off by default**, and for two different reasons worth separating.

export const DELIVERY_COD_REQUIRE_EXACT_AMOUNT_ENV = 'DELIVERY_COD_REQUIRE_EXACT_AMOUNT';

/**
 * Whether a COD collection whose amount differs from the order total is refused outright.
 *
 * **`false`, deliberately.** A driver standing at a door with less money than the order came to has
 * a real situation, and the platform's two options are to record what happened or to refuse and
 * leave no trace of it. Refusing by default would invent an exact-payment rule that no approved
 * document states — and it would push a driver towards typing the *expected* figure instead of the
 * true one, quietly converting a recorded shortfall into an unrecorded one. The shipped behaviour
 * records both numbers and lets the discrepancy be found.
 *
 * The discrepancy is never smoothed over either way: `CodCollectionPolicy.isReconcilable` refuses
 * to treat a mismatched collection as settled cash, and that is **not** configurable. What an
 * operator can choose is whether the driver is stopped at the door; what nobody can choose is
 * whether a short collection counts as a full one.
 *
 * Setting this to `true` is a commercial decision — "COD must be exact or the delivery does not
 * proceed" — and the refusal then happens at the application boundary with nothing written.
 */
export const DEFAULT_DELIVERY_COD_REQUIRE_EXACT_AMOUNT = false;

export const DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION_ENV =
  'DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION';

/**
 * Whether a COD delivery must have a recorded collection before its job may reach `COMPLETED`.
 *
 * **`false`, and here the reason is specific to this platform rather than a general preference.**
 * Every Slice-1 order is cash on delivery — `CheckoutCommand` writes `isCod: true`
 * unconditionally, because there is no other payment path yet — so this flag applies to *every
 * delivery on the platform*, not to a subset. No driver application posts a collection today.
 * Switching it on by default would therefore strand every delivery at `DELIVERED` from the moment
 * this shipped, which is a platform outage dressed as a business rule.
 *
 * It exists because the rule is the right one once collections are actually being posted: a
 * platform that closes its books on a cash delivery without recording the cash has lost track of
 * money. Turning it on is a config change, and the honest sequencing is to turn it on when the
 * driver app can satisfy it.
 *
 * Note what it does **not** gate. `DELIVERED` is never blocked by COD — that is a statement about
 * the physical world, and a bookkeeping rule must not be able to retract it. And the gate asks only
 * that the collection be *recorded*, never that it be remitted or reconciled: those are slower
 * processes belonging to a cadence the design's Open Question 5 leaves undecided, and a delivery
 * job must not stay open waiting on them.
 */
export const DEFAULT_DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION = false;

function readCodFlag(envKey: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[envKey];
  if (raw === undefined || String(raw).trim() === '') {
    return fallback;
  }
  return String(raw).trim().toLowerCase() === 'true';
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readCodRequireExactAmount(env: NodeJS.ProcessEnv = process.env): boolean {
  return readCodFlag(
    DELIVERY_COD_REQUIRE_EXACT_AMOUNT_ENV,
    DEFAULT_DELIVERY_COD_REQUIRE_EXACT_AMOUNT,
    env,
  );
}

/** Parses the env value, falling back to the default when unset or blank. */
export function readCodRequireCollectionForCompletion(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readCodFlag(
    DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION_ENV,
    DEFAULT_DELIVERY_COD_REQUIRE_COLLECTION_FOR_COMPLETION,
    env,
  );
}

// ---------------------------------------------------------------------------------------------
// Background recovery workers (module-08 §6.5, §11.5 — the final readiness pass)
//
// Three workers share this section, and every value here is a *pace*, never a rule. None of them
// decides whether something may happen; they decide how soon somebody notices that it already
// has. That distinction is why the defaults can be tuned per deployment without anybody having to
// re-read the delivery state machine: set them all to their maximum and the platform still behaves
// correctly, just less promptly, because every guarantee the workers provide is also enforced on
// the request path by `DispatchDeliveryJobCommand` reading `expiresAt` whenever it looks at an
// offer.
// ---------------------------------------------------------------------------------------------

export const DELIVERY_RECOVERY_BATCH_SIZE_ENV = 'DELIVERY_RECOVERY_BATCH_SIZE';

/**
 * The most rows any one worker tick will process (§2's sweeper, §3's and §4's recovery).
 *
 * A bound rather than a target: a healthy platform has nothing to sweep and every tick stops at
 * the first empty read. It matters only after an outage, when a backlog has built up, and there
 * the question is how much work one tick may take before yielding — an unbounded tick would hold a
 * database connection for as long as the backlog took to drain, on every instance at once.
 *
 * Fifty is deliberately modest. Each row costs a transaction and, for the recovery workers, a
 * cross-module candidate search; draining a backlog over several ticks a minute apart is
 * preferable to one tick that monopolises a connection. Nothing is lost by stopping early — the
 * remaining rows are still in the same query on the next tick, which is what makes the workers
 * restart-safe in the first place.
 */
export const DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE = 50;

/** Bounds enforced in `env.validation.ts`. One row a tick is slow but valid; the ceiling is the
 * point past which a single tick stops being a bounded unit of work. */
export const MIN_DELIVERY_RECOVERY_BATCH_SIZE = 1;
export const MAX_DELIVERY_RECOVERY_BATCH_SIZE = 1_000;

/** Parses the env value, falling back to the default when unset or blank. */
export function readRecoveryBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_RECOVERY_BATCH_SIZE_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_RECOVERY_BATCH_SIZE;
  }
  return Number(raw);
}

export const DELIVERY_RECOVERY_QUIET_SECONDS_ENV = 'DELIVERY_RECOVERY_QUIET_SECONDS';

/**
 * How long a job wanting a driver must have sat untouched before `DispatchRecoverySweeper` treats
 * it as stalled (§6.5's `NO_DRIVER_AVAILABLE`, §11.5's interrupted reassignment).
 *
 * This is the setting that separates *recovery* from *interference*. Dispatch is a multi-step flow
 * that briefly leaves a job with no live offer — a reassignment releases the driver in one
 * transaction and re-dispatches in the next, precisely so the candidate search does not run inside
 * a `Serializable` transaction — and a worker that pounced on that window would be racing the very
 * command that is mid-flight, not recovering from a crash.
 *
 * Sixty seconds is comfortably longer than any such window (they are single-digit milliseconds)
 * and short enough that a genuinely stranded job is picked up within a minute or two of the next
 * tick. Raising it delays recovery; lowering it towards zero starts contending with live dispatch,
 * which the partial unique index will resolve correctly but wastefully.
 */
export const DEFAULT_DELIVERY_RECOVERY_QUIET_SECONDS = 60;

/** Bounds enforced in `env.validation.ts`. `0` is legal and means "no quiet period" — the setting
 * a test uses to observe recovery without waiting; production should not run there, for the reason
 * the default's note gives. */
export const MIN_DELIVERY_RECOVERY_QUIET_SECONDS = 0;
export const MAX_DELIVERY_RECOVERY_QUIET_SECONDS = 86_400;

/** Parses the env value, falling back to the default when unset or blank. */
export function readRecoveryQuietSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_RECOVERY_QUIET_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_RECOVERY_QUIET_SECONDS;
  }
  return Number(raw);
}

export const DELIVERY_STALE_ASSIGNMENT_SECONDS_ENV = 'DELIVERY_STALE_ASSIGNMENT_SECONDS';

/**
 * How long a pre-pickup job may sit with an assigned driver who is no longer working before
 * `StaleAssignmentSweeper` reassigns it (§11.5, F-JOB-05).
 *
 * Much longer than the recovery quiet period, and for a different reason: this one takes work
 * *away from a named driver*, so the cost of acting too early is a driver losing a job they were
 * about to do. A driver's app loses connectivity in a lift, in a basement car park, at a pharmacy
 * counter with thick walls; five minutes is long enough that ordinary gaps pass and short enough
 * that a customer is not waiting on somebody who has gone home.
 *
 * It is not a promise that a job is reassigned five minutes after a driver goes offline — it is
 * the minimum. The job must also have been *untouched* that long, so a driver who goes offline but
 * keeps posting status updates keeps their job, which is the right answer: they are evidently still
 * working it.
 */
export const DEFAULT_DELIVERY_STALE_ASSIGNMENT_SECONDS = 300;

/** Bounds enforced in `env.validation.ts`. `0` is legal for tests, as above. */
export const MIN_DELIVERY_STALE_ASSIGNMENT_SECONDS = 0;
export const MAX_DELIVERY_STALE_ASSIGNMENT_SECONDS = 86_400;

/** Parses the env value, falling back to the default when unset or blank. */
export function readStaleAssignmentSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DELIVERY_STALE_ASSIGNMENT_SECONDS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_DELIVERY_STALE_ASSIGNMENT_SECONDS;
  }
  return Number(raw);
}

export const deliveryConfig = registerAs('delivery', () => ({
  maxConcurrentJobs: readMaxConcurrentJobs(),
  offerTtlSeconds: readOfferTtlSeconds(),
  locationWriteIntervalSeconds: readLocationWriteIntervalSeconds(),
  locationCacheTtlSeconds: readLocationCacheTtlSeconds(),
  etaCacheTtlSeconds: readEtaCacheTtlSeconds(),
  etaRecalculateAfterMeters: readEtaRecalculateAfterMeters(),
  etaMaxLocationAgeSeconds: readEtaMaxLocationAgeSeconds(),
  podRequirement: readPodBaseRequirement(),
  podColdChainRequirement: readPodColdChainRequirement(),
  podCodRequirement: readPodCodRequirement(),
  podMaxArtifactBytes: readPodMaxArtifactBytes(),
  feeBase: readFeeBase(),
  feePerKm: readFeePerKm(),
  feeMinimum: readFeeMinimum(),
  feeMaximum: readFeeMaximum(),
  feeRoundTo: readFeeRoundTo(),
  feePricingVersion: readFeePricingVersion(),
  feeZones: readFeeZones(),
  earningBase: readEarningBase(),
  earningPerKm: readEarningPerKm(),
  earningFeeSharePercent: readEarningFeeSharePercent(),
  earningMinimum: readEarningMinimum(),
  earningMaximum: readEarningMaximum(),
  earningRoundTo: readEarningRoundTo(),
  earningVersion: readEarningVersion(),
  codRequireExactAmount: readCodRequireExactAmount(),
  codRequireCollectionForCompletion: readCodRequireCollectionForCompletion(),
  recoveryBatchSize: readRecoveryBatchSize(),
  recoveryQuietSeconds: readRecoveryQuietSeconds(),
  staleAssignmentSeconds: readStaleAssignmentSeconds(),
}));
