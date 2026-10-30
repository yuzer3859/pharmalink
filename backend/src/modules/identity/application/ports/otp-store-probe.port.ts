export const OTP_STORE_PROBE = Symbol('OTP_STORE_PROBE');

/**
 * Reports whether the bound OTP store can serve a code issued by *this* process to *another* one
 * (Work 65). The first-Super-Admin CLI issues the verification code, exits, and the HTTP server
 * verifies it, so it needs a shared store (Redis), reachable now. The in-memory store keeps codes
 * in the process that issued them, which the server could never see.
 *
 * Bound to the same instance as `OTP_SERVICE`. Kept separate from `IOtpService` so the request
 * paths, and their test doubles, are unchanged.
 */
export interface IOtpStoreProbe {
  /** Throws `IdentityErrors.otpUnavailable()` when a shared store is configured but unreachable. */
  probe(): Promise<{ shared: boolean }>;
}
