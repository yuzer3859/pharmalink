import { CheckoutResult } from '../../application/commands/checkout.command';

/** One placed order line, as the client sees it. */
export interface CheckoutLineResponse {
  catalogProductId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  requiresRx: boolean;
}

/**
 * `POST /checkout` response (`06-orders-spec.md` §287 — `201 { orderId, orderNumber, status }`,
 * widened to carry the totals/fulfillment/invoice the client needs to render a confirmation
 * without an immediate follow-up `GET /orders/:id`).
 *
 * An explicit projection, never the repository snapshot or the Prisma model: `OrderSnapshot`
 * carries internal columns (`idempotencyKey`, `matchRequestId`, `paymentId`, `strategy`,
 * `cancelledAt`/`cancelReason`, `reservationId` and `prescriptionLineId` per line) that no client
 * needs and that would become an accidental public contract if leaked. `paymentIntent` from the
 * parent design's §211 shape is absent — Slice 1 is COD-only and Module 07 does not exist.
 */
export interface CheckoutResponse {
  orderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  grandTotal: number;
  isCod: boolean;
  placedAt: Date | null;
  pharmacyId: string;
  branchId: string;
  invoiceNumber: string;
  lines: CheckoutLineResponse[];
  /** `true` when the `idempotencyKey` replayed an already-placed order instead of creating one
   * (§4/§13.5) — the client can distinguish "your retry was absorbed" from "a new order". */
  replay: boolean;
}

/** Pure mapping, no business logic — keeps the controller free of shape-building. */
export function toCheckoutResponse(result: CheckoutResult): CheckoutResponse {
  const { order, lines, fulfillment, invoice, replay } = result;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    platformFee: order.platformFee,
    discountTotal: order.discountTotal,
    grandTotal: order.grandTotal,
    isCod: order.isCod,
    placedAt: order.placedAt,
    pharmacyId: fulfillment.pharmacyId,
    branchId: fulfillment.branchId,
    invoiceNumber: invoice.invoiceNumber,
    lines: lines.map((line) => ({
      catalogProductId: line.catalogProductId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      requiresRx: line.requiresRx,
    })),
    replay,
  };
}
