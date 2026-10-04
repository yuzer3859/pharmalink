export const PHARMACY_PORT = Symbol('DELIVERY_PHARMACY_PORT');

/** The pickup point, as delivery needs it: where to go, and what to call the place. */
export interface BranchPickupView {
  branchId: string;
  pharmacyId: string;
  lat: number | null;
  lng: number | null;
  /** A single human-readable line assembled from the branch's address parts. */
  addressLine: string | null;
}

/**
 * Cross-module read port into Module 04 — Pharmacy & Inventory
 * (`architecture/module-08-delivery-tracking.md` §10). Own copy per ADR-002, mirroring the copies
 * Modules 06 and 07 each keep; `PharmacyInventoryModule` exports nothing that answers this.
 *
 * Read-only, and narrow on purpose: coordinates and an address line. It does **not** expose
 * licence status, transacting eligibility or operating hours. Those are Module 04's rules to
 * enforce, and a delivery module that could read them would eventually be tempted to decide with
 * them.
 */
export interface IPharmacyPort {
  /** The branch's pickup details, or `null` when it does not exist (or is soft-deleted). */
  getBranchPickup(branchId: string): Promise<BranchPickupView | null>;
}
