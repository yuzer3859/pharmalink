/**
 * Where live OTP challenges are stored, and the secret that keys their hashes (Work 60).
 *
 * Same shape as the identity-verification provider setting (ADR-027): the store is chosen
 * explicitly, production can never select the in-memory store, and there is no fallback in either
 * direction. A Redis store that is configured but unreachable fails OTP requests closed; it never
 * switches to memory.
 */
export const OTP_STORE_ENV = 'OTP_STORE';
export const OTP_HASH_SECRET_ENV = 'OTP_HASH_SECRET';

/**
 * - `redis`  — `RedisOtpService`: hashed, single-use challenges with TTLs in the shared Redis, so
 *              they survive a backend restart and are shared by every API instance. Requires
 *              `REDIS_URL` and `OTP_HASH_SECRET`. The only production value.
 * - `memory` — `InMemoryOtpService`: one process, lost on restart. Local development and tests
 *              only; rejected in production.
 */
export const OTP_STORES = ['redis', 'memory'] as const;
export type OtpStoreName = (typeof OTP_STORES)[number];

/** At least 32 characters: the HMAC key protecting a six-digit code space from offline guessing. */
export const MIN_OTP_HASH_SECRET_LENGTH = 32;

export const DEFAULT_OTP_TTL_SECONDS = 300;
export const MIN_OTP_TTL_SECONDS = 30;
export const MAX_OTP_TTL_SECONDS = 3600;
export const DEFAULT_OTP_MAX_ATTEMPTS = 5;
export const MIN_OTP_MAX_ATTEMPTS = 1;
export const MAX_OTP_MAX_ATTEMPTS = 20;
export const DEFAULT_OTP_RESEND_COOLDOWN_SECONDS = 30;
export const MIN_OTP_RESEND_COOLDOWN_SECONDS = 1;
export const MAX_OTP_RESEND_COOLDOWN_SECONDS = 3600;

/** Placeholder text from `.env.example` and common stand-ins that must never key real hashes. */
const PLACEHOLDER_SECRET = /replace[_-]?me|change[_-]?me|placeholder|example/i;

export interface OtpStoreSettings {
  nodeEnv: string | undefined;
  store: unknown;
  redisUrl: unknown;
  hashSecret: unknown;
  /** Other secrets the OTP key must not reuse. */
  otherSecrets?: unknown[];
}

function present(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Throws with an actionable message when `OTP_HASH_SECRET` is unusable. The message never contains
 * the value.
 */
export function assertOtpHashSecret(raw: unknown, otherSecrets: unknown[] = []): string {
  const secret = present(raw);
  if (secret === undefined) {
    throw new Error(`${OTP_HASH_SECRET_ENV} must be set when ${OTP_STORE_ENV}=redis.`);
  }
  if (secret.length < MIN_OTP_HASH_SECRET_LENGTH) {
    throw new Error(`${OTP_HASH_SECRET_ENV} must be at least ${MIN_OTP_HASH_SECRET_LENGTH} characters.`);
  }
  if (PLACEHOLDER_SECRET.test(secret) || new Set(secret).size < 8) {
    throw new Error(`${OTP_HASH_SECRET_ENV} looks like a placeholder; generate a random value.`);
  }
  if (otherSecrets.some((other) => present(other) === secret)) {
    throw new Error(`${OTP_HASH_SECRET_ENV} must be a dedicated secret, not a copy of another one.`);
  }
  return secret;
}

/**
 * Resolves the effective OTP store, or throws. The single source of the rule: `validateEnv` calls
 * it at boot and the identity module's provider factory calls it again before choosing an adapter.
 *
 * Unset means `redis` in production and `memory` elsewhere, so local development and the test
 * suite keep running without Redis.
 */
export function resolveOtpStore(settings: OtpStoreSettings): OtpStoreName {
  const value = present(settings.store);
  const production = settings.nodeEnv === 'production';

  if (value !== undefined && !(OTP_STORES as readonly string[]).includes(value)) {
    throw new Error(`${OTP_STORE_ENV} must be one of ${OTP_STORES.join(', ')} (got "${value}").`);
  }
  if (production && value === 'memory') {
    throw new Error(
      `${OTP_STORE_ENV}=memory is not allowed in production: in-memory OTPs are per process and lost on restart.`,
    );
  }

  const store = (value ?? (production ? 'redis' : 'memory')) as OtpStoreName;
  if (store === 'redis') {
    if (present(settings.redisUrl) === undefined) {
      throw new Error(`${OTP_STORE_ENV}=redis requires REDIS_URL${production ? ' (production stores OTPs in Redis only)' : ''}.`);
    }
    assertOtpHashSecret(settings.hashSecret, settings.otherSecrets);
  }
  return store;
}
