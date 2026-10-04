import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IConfigPort } from './config.port';
import { EnvironmentVariables, NodeEnv } from './env.validation';

/**
 * Env-backed implementation of IConfigPort. Typed accessors for known variables plus a
 * generic get/getOrThrow. Feature flags are read from FEATURE_<FLAG>=true for now; Module 16
 * will supersede isFeatureEnabled() with a DB-backed evaluator.
 */
@Injectable()
export class AppConfigService implements IConfigPort {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  get<T = string>(key: string): T | undefined {
    return this.config.get(key as keyof EnvironmentVariables) as unknown as T | undefined;
  }

  getOrThrow<T = string>(key: string): T {
    return this.config.getOrThrow(key as keyof EnvironmentVariables) as unknown as T;
  }

  isFeatureEnabled(flag: string): boolean {
    const raw = this.config.get(`FEATURE_${flag.toUpperCase()}` as keyof EnvironmentVariables);
    return String(raw).toLowerCase() === 'true';
  }

  get nodeEnv(): NodeEnv {
    return this.config.get('NODE_ENV', { infer: true }) as NodeEnv;
  }

  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }

  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }

  get port(): number {
    return Number(this.config.get('PORT', { infer: true }) ?? 3000);
  }

  get databaseUrl(): string {
    return this.config.getOrThrow('DATABASE_URL', { infer: true });
  }

  get masterEncryptionKey(): string {
    return this.config.getOrThrow('MASTER_ENCRYPTION_KEY', { infer: true });
  }

  get jwtAccessSecret(): string {
    return this.config.getOrThrow('JWT_ACCESS_SECRET', { infer: true });
  }

  get jwtRefreshSecret(): string {
    return this.config.getOrThrow('JWT_REFRESH_SECRET', { infer: true });
  }

  /** Access-token lifetime in seconds (default 15 min, per module-01 §7). */
  get accessTokenTtlSeconds(): number {
    return Number(this.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
  }

  /** Refresh-token lifetime in days (default 30, per module-01 §7). */
  get refreshTokenTtlDays(): number {
    return Number(this.get('JWT_REFRESH_TTL_DAYS') ?? 30);
  }

  /** OTP lifetime in seconds (default 5 min, per module-01 §7). */
  get otpTtlSeconds(): number {
    return Number(this.get('OTP_TTL_SECONDS') ?? 300);
  }

  /** Max OTP verification attempts before lockout (default 5). */
  get otpMaxAttempts(): number {
    return Number(this.get('OTP_MAX_ATTEMPTS') ?? 5);
  }
}
