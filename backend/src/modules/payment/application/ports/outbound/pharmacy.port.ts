export const PHARMACY_PORT = Symbol('PAYMENT_PHARMACY_PORT');

/**
 * Cross-module read port into Module 04 — Pharmacy & Inventory. Own copy per ADR-002, mirroring
 * Module 06's `IPharmacyPort` in shape only.
 *
 * It exists because the two id spaces never overlap: `IIdentityPort.getUserOrganizationIds()`
 * returns **`Organization.id`**s, while a settlement is keyed by **`Pharmacy.id`**
 * (`PROVIDER_PAYABLE.ownerId`). Passing the former where the latter is expected does not error —
 * it silently matches nothing, which on a *read* looks like "you have no statements" and on a
 * scope check would look like "this statement is not yours". Both failures are quiet, so the
 * translation gets its own named seam.
 *
 * Strictly an ownership mapping. It projects `id` and nothing else — no licence, no transacting
 * status, no verification state — so it cannot drift into re-deciding Module 04's eligibility
 * rules from inside a money module.
 */
export interface IPharmacyPort {
  /**
   * Every `Pharmacy.id` owned by any of `organizationIds`. Returns an empty array for an empty
   * input rather than issuing an unscoped query — the difference between "this caller owns
   * nothing" and "no filter" is the difference between an empty page and every provider's
   * statements.
   */
  findPharmacyIdsByOrganizationIds(organizationIds: string[]): Promise<string[]>;
}
