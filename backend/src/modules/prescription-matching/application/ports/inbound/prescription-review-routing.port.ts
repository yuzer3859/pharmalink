export const PRESCRIPTION_REVIEW_ROUTING_PORT = Symbol('PRESCRIPTION_REVIEW_ROUTING_PORT');

/** Where the customer's prescription review stands, as checkout shows it. */
export interface PrescriptionReviewRouting {
  prescriptionId: string;
  status: string;
  /** The pharmacy organisation whose pharmacist reviews it. */
  verifyingOrganizationId: string;
  /** True when this call is the one that sent it there. */
  routedNow: boolean;
}

/**
 * Work 109 (owner decision 2026-11-09, "verify before paying"): module-05 Model A, where the
 * dispensing pharmacy's pharmacist verifies. Before this, nothing in the product flow ever called
 * `AssignVerifyingPharmacyCommand` (§20 Decision 6 left the call site "to confirm later"), so an
 * uploaded prescription reached no pharmacist's queue.
 *
 * - `routeForReview` is called by Module 06's checkout quote when the cart has prescription items
 *   the Rx gate blocks. The customer's **newest** `UPLOADED` prescription not yet routed goes to the
 *   pharmacy the quote ranked first; that pharmacy's pharmacist then reviews it in the portal.
 *   When there is nothing to route, it reports the newest prescription already waiting for review,
 *   if any, so checkout can say where it is. It never moves a prescription already with a pharmacy.
 * - `verifyingOrganizationsFor` lets checkout place the order with the pharmacy that approved the
 *   prescription lines it dispenses against, so the verifier is the dispenser.
 *
 * Both take an explicit `customerUserId`; nothing here crosses customers.
 */
export interface IPrescriptionReviewRoutingPort {
  routeForReview(input: { customerUserId: string; verifyingOrganizationId: string }): Promise<PrescriptionReviewRouting | null>;
  verifyingOrganizationsFor(input: { customerUserId: string; prescriptionLineIds: string[] }): Promise<string[]>;
}
