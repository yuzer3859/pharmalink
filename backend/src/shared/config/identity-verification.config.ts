/**
 * Which national-ID verification provider the identity module uses (Work 58, ADR-027).
 *
 * Runtime mode (`NODE_ENV`) and provider selection are separate settings. Production must name its
 * provider explicitly and can never select the mock; development and test default to the mock so
 * local work, CI and the local staging rehearsal keep running unchanged. There is no fallback in
 * either direction: an invalid or contradictory value stops the process at boot.
 */
export const IDENTITY_VERIFICATION_PROVIDER_ENV = 'IDENTITY_VERIFICATION_PROVIDER';

/**
 * - `mock`  — `MockFaydaProvider`: format check only, auto-approves; never real verification.
 *             Allowed only outside production.
 * - `fayda` — the real Fayda integration, supplied through the identity module's composition
 *             boundary (`FAYDA_VERIFICATION_PROVIDER`). Not implemented yet, so selecting it fails
 *             at startup until an adapter is registered.
 */
export const IDENTITY_VERIFICATION_PROVIDERS = ['mock', 'fayda'] as const;
export type IdentityVerificationProviderName = (typeof IDENTITY_VERIFICATION_PROVIDERS)[number];

/**
 * Resolves the effective provider from `NODE_ENV` and the raw setting, or throws with an
 * actionable message. The single source of the rule: `validateEnv` calls it at boot and the
 * identity module's provider factory calls it again before choosing an adapter.
 */
export function resolveIdentityVerificationProvider(
  nodeEnv: string | undefined,
  raw: unknown,
): IdentityVerificationProviderName {
  const value = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  const production = nodeEnv === 'production';

  if (value !== undefined && !(IDENTITY_VERIFICATION_PROVIDERS as readonly string[]).includes(value)) {
    throw new Error(
      `${IDENTITY_VERIFICATION_PROVIDER_ENV} must be one of ${IDENTITY_VERIFICATION_PROVIDERS.join(', ')} (got "${value}").`,
    );
  }
  if (production && value === undefined) {
    throw new Error(
      `${IDENTITY_VERIFICATION_PROVIDER_ENV} must be set explicitly in production; the only production value is "fayda".`,
    );
  }
  if (production && value === 'mock') {
    throw new Error(
      `${IDENTITY_VERIFICATION_PROVIDER_ENV}=mock is not allowed in production: the mock provider is not real identity verification.`,
    );
  }
  return (value ?? 'mock') as IdentityVerificationProviderName;
}
