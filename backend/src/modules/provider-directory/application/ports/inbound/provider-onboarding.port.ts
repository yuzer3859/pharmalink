import type { ProviderStatus, ProviderType } from '../../../domain/provider-rules';

export const PROVIDER_ONBOARDING_PORT = Symbol('PROVIDER_ONBOARDING_PORT');

export interface ProviderSummary {
  providerId: string;
  organizationId: string;
  type: ProviderType;
  displayName: string;
  status: ProviderStatus;
  licenseStatus: string;
  licenseExpiresAt: Date | null;
}

/**
 * Work 160: Module 09's steps of registering and controlling a healthcare provider, for a
 * platform administrator (module-09 §8.3). `register` creates the provider for an organisation
 * its administrator owns; `activate` checks the organisation is ACTIVE on an approved, current
 * facility licence; `suspend` and `reactivate` are the manual, audited controls.
 */
export interface IProviderOnboardingPort {
  findByOrganization(organizationId: string): Promise<ProviderSummary | null>;
  register(input: { adminUserId: string; organizationId: string; type: ProviderType; displayName: string }): Promise<{ providerId: string }>;
  /** `false` when it was already active on the same licence. */
  activate(input: { actorUserId: string; providerId: string }): Promise<boolean>;
  /** `false` when it was already suspended. */
  suspend(input: { actorUserId: string; providerId: string; reason: string }): Promise<boolean>;
  /** Activation again after a suspension, with the same licence checks. `false` when already active. */
  reactivate(input: { actorUserId: string; providerId: string }): Promise<boolean>;
}
