import type { ProviderType } from '../../../domain/provider-rules';

export const PROVIDER_FACILITY_PORT = Symbol('PROVIDER_FACILITY_PORT');

export interface FacilitySummary {
  providerId: string;
  type: ProviderType;
  displayName: string;
  status: string;
  /** ACTIVE with a current licence (module-09 §6). */
  eligible: boolean;
}

/**
 * Work 166: what other modules need from Module 09 about facilities — the facility a caller
 * administers (narrowed by the portal's chosen organisation, Work 155), whether a department is
 * one of a facility's, and facilities' names for showing where a doctor practises. Read-only.
 */
export interface IProviderFacilityPort {
  /** The caller's facility, or `null` when they administer none. */
  callerFacility(userId: string): Promise<FacilitySummary | null>;
  /** The department's name when it belongs to that facility, else `null`. */
  departmentOf(providerId: string, departmentId: string): Promise<{ departmentId: string; name: string } | null>;
  summaries(providerIds: string[]): Promise<FacilitySummary[]>;
}
