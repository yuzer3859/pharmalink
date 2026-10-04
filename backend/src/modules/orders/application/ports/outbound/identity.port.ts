export const IDENTITY_PORT = Symbol('ORDERS_IDENTITY_PORT');

/**
 * Cross-module read port into Module 01 — Identity (module-06 `06-orders-spec.md` §5). Own copy
 * per ADR-002, not a cross-module import of Module 04/05's own `IIdentityPort` copies. Backed by
 * a direct, same-database `PrismaService` read of `user_roles`/`roles` in the infrastructure
 * layer (`infrastructure/identity/`, not built by this task) — never a Prisma relation (ADR-002).
 *
 * `hasRoleAtOrganization` backs the `order:fulfill:org` org-scoping check on
 * `AcceptFulfillmentCommand`/`PrepareFulfillmentCommand`/`MarkReadyCommand`/
 * `DeclineFulfillmentCommand` (§5, §7.1) — "is this user a `PHARMACY_OWNER`/`PHARMACY_MANAGER`/
 * `PHARMACIST` at the pharmacy that owns this fulfillment", identical shape/purpose to Module
 * 05's `VerificationPolicy` org-check. `getUserOrganizationIds` backs `GET /pharmacy/orders`'s
 * org-scoped listing (§9.4) — resolving which `pharmacyIds` a caller may see fulfillments for,
 * passed into `IFulfillmentRepository.listByPharmacyIds()`.
 */
export interface IIdentityPort {
  getUserOrganizationIds(userId: string): Promise<string[]>;
  hasRoleAtOrganization(userId: string, organizationId: string, roleKey: string): Promise<boolean>;
}
