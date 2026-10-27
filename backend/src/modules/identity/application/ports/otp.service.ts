import { OtpPurpose } from '../../domain/enums';

export const OTP_SERVICE = Symbol('OTP_SERVICE');

export enum OtpVerifyResult {
  OK = 'OK',
  INVALID = 'INVALID',
  EXPIRED = 'EXPIRED',
  ATTEMPTS_EXCEEDED = 'ATTEMPTS_EXCEEDED',
}

/** A new challenge was stored; any earlier one for the same identifier and purpose is gone. */
export interface IssuedOtp {
  status: 'ISSUED';
  /** Plaintext code, returned only so the caller can hand it to the notification port. Never
   * stored, logged or put in an error by the adapter or the caller. */
  code: string;
  /** Seconds before another code may be requested for the same identifier and purpose. */
  cooldownSeconds: number;
}

/** Refused: a code was issued too recently. Nothing changed and no code exists to send. */
export interface OtpCooldown {
  status: 'COOLDOWN';
  retryAfterSeconds: number;
}

export type OtpIssueOutcome = IssuedOtp | OtpCooldown;

/**
 * OTP issuance/verification port (module-01 §8): 6 digits, 5-minute TTL, a maximum number of
 * attempts, hashed, single-use and per purpose, with a resend cooldown.
 *
 * Production uses `RedisOtpService` (shared across instances, survives a backend restart);
 * `InMemoryOtpService` is the local/test stand-in. Both enforce the cooldown inside `issue`, so a
 * caller cannot send a code the store refused.
 *
 * When the store cannot answer, both methods throw `IdentityErrors.otpUnavailable()`
 * (`DEPENDENCY_UNAVAILABLE`, 503). They never report an unknown state as expired, invalid or OK.
 */
export interface IOtpService {
  issue(identifier: string, purpose: OtpPurpose): Promise<OtpIssueOutcome>;
  verify(identifier: string, purpose: OtpPurpose, code: string): Promise<OtpVerifyResult>;
}
