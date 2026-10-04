export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

export interface OrganizationView {
  id: string;
  type: string;
  status: string;
  licenseNumber: string | null;
  licenseExpiresAt: Date | null;
}

/**
 * Cross-module read port into Module 01 — Identity (module-04 §2). Backed by an in-process,
 * same-database adapter (`infrastructure/identity/identity-port.adapter.ts`) — never a Prisma
 * relation (ADR-002).
 *
 * `getUserOrganizationIds` is an addition beyond the two methods literally named in §2 — needed
 * because `AuthenticatedPrincipal` (the JWT-derived request principal) does not itself carry an
 * `organizationId` claim; org-scope enforcement (§7.3, §15) must resolve it from `user_roles`
 * for the calling user. Flagged as a deviation in the implementation report; it is a strict
 * extension of the same port (a same-database read via `IIdentityPort`), not a new architectural
 * pattern.
 */
export interface IIdentityPort {
  getOrganization(organizationId: string): Promise<OrganizationView | null>;
  getOrganizationOwner(organizationId: string): Promise<{ userId: string } | null>;
  getUserOrganizationIds(userId: string): Promise<string[]>;
}
