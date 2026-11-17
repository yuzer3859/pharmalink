export const PRESCRIPTION_REVIEW_ROUTING_PORT = Symbol('PRESCRIPTION_REVIEW_ROUTING_PORT');

/** What the order asks to dispense against the prescription; the pharmacist approves these. */
export interface RequestedRxItem {
  catalogProductId: string;
  productName: string | null;
  quantity: number;
}

/** One approved prescription line, for the order line of the same product. */
export interface ApprovedRxLine {
  catalogProductId: string;
  prescriptionLineId: string;
}

/**
 * Work 129 (owner decision 2026-11-16): the prescription travels with the order. Every order with a
 * prescription medicine carries the prescription the customer attached at checkout, and the
 * pharmacist of the pharmacy filling the order reviews it on that order (module-05 Model A: the
 * dispenser verifies). It replaces Work 109's quote-time routing of the customer's newest upload.
 *
 * - `assertAttachable`: before checkout reserves stock, the prescription must be the customer's
 *   own, `UPLOADED`, and not yet sent to any pharmacy (one prescription, one order).
 * - `attachToOrder`: once the order exists, sends it to the filling pharmacy's organisation with
 *   what the order asks for (`UPLOADED -> PENDING_VERIFICATION`). A prescription another checkout
 *   attached first is refused, and the caller cancels its own order.
 * - `approveForOrder` / `rejectForOrder`: the pharmacist's decision, through Module 05's own
 *   approve and reject commands, which check the reviewer is a pharmacist at that pharmacy. The
 *   approval is one line per ordered product for the ordered quantity. Approving a prescription
 *   already approved returns its lines, so a retry after a crash completes the order.
 */
export interface IPrescriptionReviewRoutingPort {
  assertAttachable(input: { customerUserId: string; prescriptionId: string }): Promise<void>;
  attachToOrder(input: {
    customerUserId: string;
    prescriptionId: string;
    verifyingOrganizationId: string;
    requestedItems: RequestedRxItem[];
  }): Promise<void>;
  approveForOrder(input: {
    prescriptionId: string;
    reviewerUserId: string;
    items: Array<{ catalogProductId: string; quantity: number }>;
    legibilityOk: boolean;
    validityOk: boolean;
  }): Promise<ApprovedRxLine[]>;
  rejectForOrder(input: { prescriptionId: string; reviewerUserId: string; reason: string }): Promise<void>;
  /**
   * Work 134: a short-lived, access-logged link to the file of a prescription request offered to
   * `organizationId` — the caller has checked that offer. The user must be a PHARMACIST there.
   */
  offeredFileLink(input: { prescriptionId: string; userId: string; organizationId: string; ip?: string | null }): Promise<{ url: string; expiresAt: string; contentType: string }>;
}
