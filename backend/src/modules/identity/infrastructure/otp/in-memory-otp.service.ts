import { createHmac, randomBytes, randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OtpPurpose } from '../../domain/enums';
import { IOtpService, OtpIssueOutcome, OtpVerifyResult } from '../../application/ports/otp.service';
import { IOtpStoreProbe } from '../../application/ports/otp-store-probe.port';

interface OtpEntry {
  hash: string;
  attempts: number;
  expiresAt: number;
}

/**
 * In-memory OTP store behind IOtpService, for **local development and tests only**
 * (`OTP_STORE=memory`, the default outside production). It refuses to start in production.
 *
 * Same rules as `RedisOtpService` — TTL, attempt limit, single use, per-purpose isolation,
 * replacement and an enforced resend cooldown — but per process and lost on restart, so it cannot
 * back more than one instance. Codes are kept only as an HMAC under a key that exists for the life
 * of the process, and are never logged: tests read them from a recording notification transport.
 */
@Injectable()
export class InMemoryOtpService implements IOtpService, IOtpStoreProbe {
  private readonly store = new Map<string, OtpEntry>();
  private readonly cooldowns = new Map<string, number>();
  private readonly processKey = randomBytes(32);

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(InMemoryOtpService.name);
    if (this.config.isProduction) {
      throw new Error('InMemoryOtpService must not be used in production; set OTP_STORE=redis.');
    }
  }

  /** Codes live in this process only: another process (the HTTP server) could never verify them. */
  async probe(): Promise<{ shared: boolean }> {
    return { shared: false };
  }

  async issue(identifier: string, purpose: OtpPurpose): Promise<OtpIssueOutcome> {
    const key = this.key(identifier, purpose);
    const now = Date.now();
    const cooldownUntil = this.cooldowns.get(key) ?? 0;
    if (cooldownUntil > now) {
      return { status: 'COOLDOWN', retryAfterSeconds: Math.ceil((cooldownUntil - now) / 1000) };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const cooldownSeconds = this.config.otpResendCooldownSeconds;
    this.store.set(key, { hash: this.hash(key, code), attempts: 0, expiresAt: now + this.config.otpTtlSeconds * 1000 });
    this.cooldowns.set(key, now + cooldownSeconds * 1000);
    return { status: 'ISSUED', code, cooldownSeconds };
  }

  async verify(identifier: string, purpose: OtpPurpose, code: string): Promise<OtpVerifyResult> {
    const key = this.key(identifier, purpose);
    const entry = this.store.get(key);
    if (!entry) {
      return OtpVerifyResult.EXPIRED;
    }
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return OtpVerifyResult.EXPIRED;
    }
    if (entry.attempts >= this.config.otpMaxAttempts) {
      this.store.delete(key);
      return OtpVerifyResult.ATTEMPTS_EXCEEDED;
    }
    if (entry.hash !== this.hash(key, code)) {
      entry.attempts += 1;
      return OtpVerifyResult.INVALID;
    }

    this.store.delete(key);
    return OtpVerifyResult.OK;
  }

  /** Test harness reset: forgets every challenge and cooldown. */
  clear(): void {
    this.store.clear();
    this.cooldowns.clear();
  }

  private key(identifier: string, purpose: OtpPurpose): string {
    return `${purpose}:${identifier}`;
  }

  private hash(key: string, code: string): string {
    return createHmac('sha256', this.processKey).update(`${key}\0${code}`).digest('hex');
  }
}
