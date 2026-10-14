export const BRANCH_OPERATIONS_READ_PORT = Symbol('BRANCH_OPERATIONS_READ_PORT');

/** Every filter is a stored `branches` column or one of Module 04's existing rules, evaluated at `now`. */
export interface BranchOperationsFilter {
  pharmacyId?: string;
  /** The stored `branches.isActive` flag. */
  isActive?: boolean;
  /** At least one of the branch's listings is customer-purchasable by Work 26's rule (`true`), or none is (`false`). */
  hasPurchasableInventory?: boolean;
  /** Inclusive lower / exclusive upper bound on `createdAt`. */
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One live branch (`deletedAt IS NULL`) of a live pharmacy, as operations sees it. No name, address,
 * city, coordinate or phone — the stored flag, its pharmacy's eligibility, and counts.
 *
 * - `isActive` — the branch's own stored flag. It is **not** eligibility: an active branch of an
 *   ineligible pharmacy offers nothing to a customer.
 * - `pharmacyEligible` — `TransactingEligibilityPolicy` for the branch's pharmacy at `now`, shown
 *   beside `isActive` and never merged with it.
 * - `listings` — Work 47's per-listing definitions for this branch's listings (`listing-counts.sql`):
 *   Work 08's tracked figures and Work 26's purchasable rule, which already requires an active branch,
 *   an eligible live pharmacy and unexpired stock. A branch's figures therefore add up to its
 *   pharmacy's.
 */
export interface BranchOperationsView {
  branchId: string;
  pharmacyId: string;
  isActive: boolean;
  pharmacyEligible: boolean;
  createdAt: Date;
  updatedAt: Date;
  listings: {
    total: number;
    enabled: number;
    disabled: number;
    inStock: number;
    outOfStock: number;
    customerPurchasable: number;
    customerUnpurchasable: number;
  };
}

export interface BranchOperationsPage {
  items: BranchOperationsView[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 04's exported, read-only contract for **administrative branch investigation** (module-16
 * Work 48). Separate from Work 47's pharmacy-centred port. Newest first (`createdAt`, then `id`). It
 * writes nothing.
 */
export interface IBranchOperationsReadPort {
  listBranches(filter: BranchOperationsFilter, page: number, size: number, now?: Date): Promise<BranchOperationsPage>;
  /** `null` when there is no live branch of a live pharmacy with this id. */
  getBranch(branchId: string, now?: Date): Promise<BranchOperationsView | null>;
}
