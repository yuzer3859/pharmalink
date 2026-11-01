export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

export interface OrganizationView {
  id: string;
  type: string;
  status: string;
  ownerUserId: string;
  licenseNumber: string | null;
  licenseExpiresAt: Date | null;
}

/**
 * Persisted proof of an organisation's current pharmacy licence (Work 67): an APPROVED
 * PHARMACY_LICENSE verification request Module 01 holds for this organisation and its owner, whose
 * licence number and expiry equal the organisation's current ones. Read from Identity's own rows,
 * never from a request body.
 */
export interface ApprovedPharmacyLicenseView {
  verificationRequestId: string;
  organizationId: string;
  userId: string;
  licenseNumber: string;
  expiresAt: Date;
  approvedAt: Date | null;
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
  /**
   * Undeleted organisations only. With `tx` (a Module 04 transaction) the organisation row is
   * share-locked until that transaction ends, so its status and licence can't change under a
   * decision taken from them — a read lock; Module 04 never writes Identity's rows.
   */
  getOrganization(organizationId: string, tx?: unknown): Promise<OrganizationView | null>;
  /**
   * The approved licence request matching the organisation's current licence number and expiry,
   * or null when there is none (no licence recorded, or no APPROVED request for it). Expiry is the
   * caller's to judge against its own clock.
   */
  getCurrentPharmacyLicense(organizationId: string, tx?: unknown): Promise<ApprovedPharmacyLicenseView | null>;
  getOrganizationOwner(organizationId: string): Promise<{ userId: string } | null>;
  getUserOrganizationIds(userId: string): Promise<string[]>;
}
