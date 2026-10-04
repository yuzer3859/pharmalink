export const IDENTITY_PORT = Symbol('PRESCRIPTION_MATCHING_IDENTITY_PORT');

/**
 * Cross-module read port into Module 01 — Identity (module-05 §2.1). Own copy per ADR-002 — not
 * a cross-module import of `modules/pharmacy-inventory/application/ports/outbound/identity.port.ts`.
 * Backed by a direct, same-database `PrismaService` read of `user_roles`/`roles` in the
 * infrastructure layer (`infrastructure/identity/`, not built by this task) — never a Prisma
 * relation (ADR-002).
 *
 * Both methods are named explicitly in §2.1: `getUserOrganizationIds` mirrors Module 04's own
 * precedent of extending its `IIdentityPort` copy beyond the two methods literally named in the
 * parent doc; `hasRoleAtOrganization` is new here, needed to confirm "is this user a
 * `PHARMACIST` at the pharmacy that is verifying/dispensing" — it backs
 * `VerificationPolicy.canReview()`'s `isPharmacistAtPharmacy` input (§3.9), since only the
 * application layer can reach identity/RBAC data and the pure policy stays framework-free.
 */
export interface IIdentityPort {
  getUserOrganizationIds(userId: string): Promise<string[]>;
  hasRoleAtOrganization(userId: string, organizationId: string, roleKey: string): Promise<boolean>;
}
