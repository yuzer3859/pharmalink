import { randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { OtpPurpose } from '../../domain/enums';
import { IOtpService, IssuedOtp, OtpVerifyResult } from '../../application/ports/otp.service';

interface OtpEntry {
  code: string;
  attempts: number;
  expiresAt: number;
}

/**
 * In-memory OTP adapter (module-01 §8) behind IOtpService — a Redis-backed adapter (5-min TTL,
 * hashed codes, sliding cooldown across process restarts) replaces this 1:1 for production. The
 * code is logged rather than actually sent since no SMS/email provider is wired in this slice.
 */
@Injectable()
export class InMemoryOtpService implements IOtpService {
  private readonly store = new Map<string, OtpEntry>();
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(InMemoryOtpService.name);
  }

  async issue(identifier: string, purpose: OtpPurpose): Promise<IssuedOtp> {
    const key = this.key(identifier, purpose);
    const cooldownUntil = this.cooldowns.get(key) ?? 0;
    const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttlMs = this.config.otpTtlSeconds * 1000;
    this.store.set(key, { code, attempts: 0, expiresAt: Date.now() + ttlMs });
    this.cooldowns.set(key, Date.now() + 30_000);

    this.logger.log(`OTP issued for ${purpose} (dev-mode, not actually delivered): ${code}`);

    return { code, cooldownSeconds };
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
    if (entry.code !== code) {
      entry.attempts += 1;
      return OtpVerifyResult.INVALID;
    }

    this.store.delete(key);
    return OtpVerifyResult.OK;
  }

  private key(identifier: string, purpose: OtpPurpose): string {
    return `${purpose}:${identifier}`;
  }
}
