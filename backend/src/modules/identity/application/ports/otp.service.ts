import { OtpPurpose } from '../../domain/enums';

export const OTP_SERVICE = Symbol('OTP_SERVICE');

export enum OtpVerifyResult {
  OK = 'OK',
  INVALID = 'INVALID',
  EXPIRED = 'EXPIRED',
  ATTEMPTS_EXCEEDED = 'ATTEMPTS_EXCEEDED',
}

export interface IssuedOtp {
  /** Plaintext code — the adapter is responsible for delivering it (SMS/email) or logging it
   * in dev. Never persisted or logged in plaintext by callers. */
  code: string;
  cooldownSeconds: number;
}

/**
 * OTP issuance/verification port (module-01 §8). Backed by Redis in production (5-min TTL,
 * max attempts, hashed, single-use); this slice ships an in-memory mock adapter behind the same
 * port so the use cases and HTTP surface are already final.
 */
export interface IOtpService {
  issue(identifier: string, purpose: OtpPurpose): Promise<IssuedOtp>;
  verify(identifier: string, purpose: OtpPurpose, code: string): Promise<OtpVerifyResult>;
}
