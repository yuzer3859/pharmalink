import { SetMetadata } from '@nestjs/common';

export const SENSITIVE_RATE_LIMIT_KEY = 'sensitiveRateLimit';

/**
 * Applies the strict `auth` rate limit (`RATE_LIMIT_AUTH_LIMIT` per `RATE_LIMIT_AUTH_TTL_SECONDS`,
 * per client, per route) on top of the default limit (Work 59). For credential, OTP, recovery and
 * identity-verification endpoints — anything an attacker could brute-force or use to flood a user.
 */
export const SensitiveRateLimit = () => SetMetadata(SENSITIVE_RATE_LIMIT_KEY, true);
