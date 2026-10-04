export const IDENTITY_VERIFICATION_PROVIDER = Symbol('IDENTITY_VERIFICATION_PROVIDER');

export interface FaydaVerificationInput {
  /** Fayda FIN/FAN as entered by the user. Never persisted in plaintext (module-01 §9.4). */
  faydaId: string;
  /** Profile values to match against the national registry (module-01 §9.2 step 4). */
  fullName?: string | null;
  dateOfBirth?: string | null;
}

export interface FaydaVerificationResult {
  matched: boolean;
  /** Provider-side reference for support/audit; safe to store. */
  providerReference?: string | null;
  /** Populated when `matched` is false — a display-safe reason. */
  failureReason?: string | null;
}

/**
 * Pluggable national-ID verification port (module-01 §9). Keeping this behind an interface lets
 * us mock in dev and swap the Fayda provider without touching the domain — the adapter owns all
 * knowledge of the provider's API, retries and error shapes.
 */
export interface IIdentityVerificationProvider {
  verifyFayda(input: FaydaVerificationInput): Promise<FaydaVerificationResult>;
}
