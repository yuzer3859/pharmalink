import { OrdersErrors } from '../errors';
import { Quantity } from '../value-objects/quantity';

/** Only the fields `PricingCalculator` itself needs — mirrors module-05's `DispensableLine`/
 * `RxGateLine` pattern of declaring a minimal, locally-scoped input shape rather than depending
 * on a not-yet-built repository/aggregate snapshot type (module-06 spec §14 — no repositories in
 * this task). */
export interface PriceableLine {
  unitPrice: number;
  quantity: number;
}

export interface PriceableLineTotal extends PriceableLine {
  lineTotal: number;
}

export interface PricingInput {
  lines: PriceableLine[];
  /**
   * Already resolved by the caller (application layer) — an integer minor-unit amount, never read
   * from configuration here (§0/§14: "keep infrastructure checks out of the domain").
   *
   * **Who resolves it changed; this contract did not.** The checkout paths now obtain it from
   * Module 08's `IDeliveryPricingPort`, which prices the delivery by distance and zone against the
   * matched branch (F-FEE-01, BR-DEL-09); the cart-level views, which have no branch and no
   * destination to route between, still pass the flat `orders.deliveryFeeFlat` key. This function
   * is indifferent to both and remains the sole owner of the total.
   */
  deliveryFee: number;
  /** Already resolved from `IConfigPort`'s `orders.platformFeePercent`, 0–1. The *multiplication*
   * (a business rule, not an I/O concern) is this calculator's job. */
  platformFeePercent: number;
  /** Always `0` in Slice 1 — no coupons/wallet exist (Module 07 absent, §0.2/§5). Accepted as an
   * optional input, not computed, so a future Slice-2 caller can pass a real value without this
   * function's shape changing. */
  discountTotal?: number;
  currency?: string;
}

export interface OrderTotals {
  lines: PriceableLineTotal[];
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  grandTotal: number;
  currency: string;
}

/** ADR-005: money is always ETB minor-unit integers in this codebase — Slice 1 has no
 * multi-currency support anywhere, so this is the only currency `computeTotals` accepts. */
const SUPPORTED_CURRENCY = 'ETB';

/**
 * Deterministic order-totals calculation (module-06 `06-orders-spec.md` §3.10/§3.11 invariant 2,
 * §5). Pure — no Prisma, no NestJS, no HTTP, no external service calls; every monetary input it
 * needs is already resolved by the caller. `Order.grandTotal` must be computed fresh, inside the
 * checkout transaction, from real Module 03 prices — never trusted from a stale cart-level cache
 * (the same "recompute inside the transaction" discipline module-05 §3.11.3 already established)
 * — this function is that computation, invoked by the application layer with fresh inputs, not a
 * cache reader itself.
 */
export const PricingCalculator = {
  computeTotals(input: PricingInput): OrderTotals {
    const currency = input.currency ?? SUPPORTED_CURRENCY;
    if (currency !== SUPPORTED_CURRENCY) {
      throw OrdersErrors.validation(`Unsupported currency: ${currency}. Only ETB is supported.`, {
        field: 'currency',
      });
    }
    if (!Number.isInteger(input.deliveryFee) || input.deliveryFee < 0) {
      throw OrdersErrors.validation('deliveryFee must be a non-negative integer.', {
        field: 'deliveryFee',
      });
    }
    if (
      typeof input.platformFeePercent !== 'number' ||
      Number.isNaN(input.platformFeePercent) ||
      input.platformFeePercent < 0 ||
      input.platformFeePercent > 1
    ) {
      throw OrdersErrors.validation('platformFeePercent must be a number between 0 and 1.', {
        field: 'platformFeePercent',
      });
    }
    const discountTotal = input.discountTotal ?? 0;
    if (!Number.isInteger(discountTotal) || discountTotal < 0) {
      throw OrdersErrors.validation('discountTotal must be a non-negative integer.', {
        field: 'discountTotal',
      });
    }

    const lines: PriceableLineTotal[] = input.lines.map((line) => {
      Quantity.of(line.quantity);
      if (!Number.isInteger(line.unitPrice) || line.unitPrice < 0) {
        throw OrdersErrors.validation('unitPrice must be a non-negative integer.', {
          field: 'unitPrice',
        });
      }
      return { ...line, lineTotal: line.unitPrice * line.quantity };
    });

    const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    // Minor-unit integers only (ADR-005) — a fractional platform fee must round, never carry a
    // fractional minor unit forward.
    const platformFee = Math.round(subtotal * input.platformFeePercent);
    const grandTotal = Math.max(0, subtotal + input.deliveryFee + platformFee - discountTotal);

    return {
      lines,
      subtotal,
      deliveryFee: input.deliveryFee,
      platformFee,
      discountTotal,
      grandTotal,
      currency,
    };
  },
};
