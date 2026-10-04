export const PHARMACY_PORT = Symbol('ORDERS_PHARMACY_PORT');

/**
 * Cross-module read port into Module 04 — Pharmacy & Inventory (`06-orders-spec.md` §5, ADR-002).
 * Own copy, mirroring this module's `ICatalogPort`/`IAddressPort`/`IIdentityPort` copies — Module
 * 04 exports only `INVENTORY_PORT` and `GetAvailabilityQuery`, neither of which can answer
 * pharmacy ownership, so Module 06 builds its own read adapter over the same database rather than
 * importing Module 04's repositories (never a Prisma relation).
 *
 * **Why this port exists.** `Fulfillment.pharmacyId` holds a `Pharmacy.id`, but role grants live
 * in Module 01's `user_roles.organizationId`, which holds an `Organization.id`. `Pharmacy`
 * carries `organizationId String @unique` — that column is the only link between the two, and no
 * previously existing contract exposed it. Without this port, `assertFulfillmentOrgScope` had to
 * pass a `Pharmacy.id` into `IIdentityPort.hasRoleAtOrganization`, which compares against
 * `Organization.id`; the two never match, so every §9.4 fulfillment action failed closed with a
 * generic not-found. Module 04 solves the same mapping internally with
 * `ResolveCallerPharmacyQuery`; this is Module 06's equivalent seam.
 *
 * Read-only. Module 06 never writes to `pharmacies`, and this port deliberately exposes only the
 * ownership mapping — not licence status, transacting eligibility, or any other Module 04
 * concern, which remain Module 04's to enforce.
 */
export interface IPharmacyPort {
  /**
   * The `Organization.id` that owns `pharmacyId`, or `null` when the pharmacy does not exist (or
   * is soft-deleted). Callers translate `null` into the same generic not-found an unauthorized
   * caller receives, so a missing pharmacy is indistinguishable from one the caller may not see.
   */
  getOrganizationId(pharmacyId: string): Promise<string | null>;

  /**
   * The reverse mapping — every `Pharmacy.id` owned by any of `organizationIds`. Backs
   * `GET /pharmacy/orders` (§9.4), whose repository criteria are expressed in `pharmacyIds` while
   * `IIdentityPort.getUserOrganizationIds()` returns `Organization.id`s. Returns an empty array
   * for an empty input rather than issuing an unscoped query.
   */
  findPharmacyIdsByOrganizationIds(organizationIds: string[]): Promise<string[]>;
}
