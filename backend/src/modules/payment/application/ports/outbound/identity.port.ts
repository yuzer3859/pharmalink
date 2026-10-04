export const IDENTITY_PORT = Symbol('PAYMENT_IDENTITY_PORT');

/**
 * Cross-module read port into Module 01 — Identity. **Own copy per ADR-002**, not an import of
 * Module 04/05/06's `IIdentityPort`: the shape is deliberately reused, the implementation is not,
 * and `IdentityModule` exports nothing this module could depend on.
 *
 * One method, because §9.6's settlement reads need exactly one question answered: *which
 * organizations does this caller belong to?* `user_roles.organizationId` is what stores that, so
 * this is a read of Module 01's own table — never a Prisma relation (ADR-002).
 *
 * It deliberately does **not** carry Module 06's `hasRoleAtOrganization`. No Module 07 route asks
 * "is this user a `PHARMACY_OWNER` at org X"; `@RequirePermissions('settlement:read:org')` already
 * establishes *that* the caller may read provider statements, and this port answers only *whose*.
 * Adding the second method because a sibling module has one would be adding an unused authorization
 * primitive to a money module.
 */
export interface IIdentityPort {
  /**
   * The caller's `Organization.id`s. Empty when the user is attached to no organization — which
   * is an ordinary, non-exceptional answer: they are authorized to call the route and simply own
   * nothing.
   */
  getUserOrganizationIds(userId: string): Promise<string[]>;
}
