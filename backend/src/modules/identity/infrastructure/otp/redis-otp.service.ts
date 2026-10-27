import { createHmac, randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { assertOtpHashSecret, OTP_HASH_SECRET_ENV } from '../../../../shared/config/otp.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { RedisService } from '../../../../shared/redis/redis.service';
import { OtpPurpose } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { IOtpService, OtpIssueOutcome, OtpVerifyResult } from '../../application/ports/otp.service';

/** How long one OTP round trip may take before the request fails closed. */
const OTP_REDIS_TIMEOUT_MS = 2_000;

/**
 * Issue, atomically: refuse while the cooldown key lives; otherwise start the cooldown and replace
 * the challenge (old hash and attempt count gone) with a fresh one that expires after the TTL.
 * KEYS: challenge, cooldown. ARGV: code hash, ttl ms, cooldown ms.
 * Returns {1, cooldownMs} when issued, {0, remainingCooldownMs} when refused.
 */
const ISSUE_SCRIPT = `
local cooldown = redis.call('PTTL', KEYS[2])
if cooldown > 0 then return {0, cooldown} end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'h', ARGV[1], 'a', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, tonumber(ARGV[3])}
`;

/**
 * Verify, atomically, so concurrent requests are serialised by Redis: a missing challenge is
 * EXPIRED (Redis removed it at its TTL, or it was consumed or replaced); a challenge already at the
 * attempt limit is deleted and refused; a wrong hash counts one attempt; the right hash deletes the
 * challenge, so it verifies once. KEYS: challenge. ARGV: submitted code hash, max attempts.
 */
const VERIFY_SCRIPT = `
local stored = redis.call('HGET', KEYS[1], 'h')
if not stored then return {'EXPIRED'} end
local attempts = tonumber(redis.call('HGET', KEYS[1], 'a') or '0')
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {'ATTEMPTS_EXCEEDED'}
end
if stored ~= ARGV[1] then
  redis.call('HINCRBY', KEYS[1], 'a', 1)
  return {'INVALID'}
end
redis.call('DEL', KEYS[1])
return {'OK'}
`;

const VERIFY_RESULTS = new Set<string>(Object.values(OtpVerifyResult));

/**
 * Production OTP store (module-01 §8, Work 60), on the platform's shared Redis connection.
 *
 * - **No plaintext at rest.** Redis holds `HMAC-SHA256(OTP_HASH_SECRET, purpose, identifier tag,
 *   code)`. Without the secret, which Redis never sees, a dump of Redis cannot be turned back into
 *   codes by trying all 10^6 of them.
 * - **No raw identifiers in keys.** A key names an HMAC tag of the normalized phone or email, under
 *   `REDIS_KEY_PREFIX`, so environments sharing a Redis cannot collide.
 * - **Isolation.** One challenge per (identifier, purpose); a REGISTER code cannot verify LOGIN,
 *   RESET or STEP_UP, and issuing a new code replaces the old one.
 * - **Atomic.** Issue and verify are single Lua scripts, so concurrent resends cannot both pass the
 *   cooldown and concurrent verifications cannot consume one code twice or exceed the attempt limit.
 * - **Fails closed.** If Redis is unreachable, slow or errors, the request fails with
 *   `DEPENDENCY_UNAVAILABLE`. It never falls back to memory and never guesses an outcome.
 *
 * Survives a backend restart and is shared by every instance. Whether it survives a *Redis*
 * restart depends on how that Redis is operated (persistence, replication); see
 * `backend/docs/otp-storage.md`.
 */
@Injectable()
export class RedisOtpService implements IOtpService {
  private readonly secret: string;

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(RedisOtpService.name);
    if (!this.redis.isEnabled) {
      throw new Error('RedisOtpService requires REDIS_URL; the in-memory store is never substituted.');
    }
    this.secret = assertOtpHashSecret(this.config.get<string>(OTP_HASH_SECRET_ENV), [
      this.config.jwtAccessSecret,
      this.config.jwtRefreshSecret,
      this.config.masterEncryptionKey,
    ]);
  }

  async issue(identifier: string, purpose: OtpPurpose): Promise<OtpIssueOutcome> {
    const keys = this.keys(identifier, purpose);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const reply = await this.redis.runScript(
      ISSUE_SCRIPT,
      [keys.challenge, keys.cooldown],
      [
        this.codeHash(keys.tag, purpose, code),
        String(this.config.otpTtlSeconds * 1000),
        String(this.config.otpResendCooldownSeconds * 1000),
      ],
      OTP_REDIS_TIMEOUT_MS,
    );
    if (!reply || reply.length !== 2) {
      throw this.unavailable('issue', purpose);
    }
    const seconds = Math.max(1, Math.ceil(Number(reply[1]) / 1000));
    return Number(reply[0]) === 1
      ? { status: 'ISSUED', code, cooldownSeconds: seconds }
      : { status: 'COOLDOWN', retryAfterSeconds: seconds };
  }

  async verify(identifier: string, purpose: OtpPurpose, code: string): Promise<OtpVerifyResult> {
    const keys = this.keys(identifier, purpose);
    const reply = await this.redis.runScript(
      VERIFY_SCRIPT,
      [keys.challenge],
      [this.codeHash(keys.tag, purpose, code), String(this.config.otpMaxAttempts)],
      OTP_REDIS_TIMEOUT_MS,
    );
    const result = reply?.[0];
    if (typeof result !== 'string' || !VERIFY_RESULTS.has(result)) {
      throw this.unavailable('verify', purpose);
    }
    return result as OtpVerifyResult;
  }

  /**
   * Both keys share one hash tag (`{purpose:tag}`) so they live in the same slot if Redis is ever
   * clustered; a Lua script may only touch keys in one slot.
   */
  private keys(identifier: string, purpose: OtpPurpose): { tag: string; challenge: string; cooldown: string } {
    const tag = createHmac('sha256', this.secret).update(`pharmalink-otp-identifier-v1\0${identifier}`).digest('hex');
    const slot = `{${purpose}:${tag}}`;
    return { tag, challenge: this.redis.key('otp', 'v1', slot), cooldown: this.redis.key('otp', 'v1', slot, 'cooldown') };
  }

  private codeHash(tag: string, purpose: OtpPurpose, code: string): string {
    return createHmac('sha256', this.secret).update(`pharmalink-otp-code-v1\0${purpose}\0${tag}\0${code}`).digest('hex');
  }

  private unavailable(operation: 'issue' | 'verify', purpose: OtpPurpose) {
    this.logger.warn(`OTP store unavailable; refused to ${operation} a ${purpose} code.`);
    return IdentityErrors.otpUnavailable();
  }
}
