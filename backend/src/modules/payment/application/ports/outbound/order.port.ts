export const ORDER_PORT = Symbol('PAYMENT_ORDER_PORT');

/**
 * Exactly the Module 06 order facts payment authorization needs, and nothing more.
 *
 * `grandTotal`/`currency` are the **authoritative amount** (§2 BR-PAY-03/§9.1): Module 06 already
 * computed them inside its own checkout transaction from fresh Catalog prices
 * (`PricingCalculator`, module-06 §3.11 invariant 2). Module 07 re-reads that result and never
 * re-derives it — duplicating order pricing here would create a second source of truth for what
 * a customer owes, which is precisely the class of bug a money module cannot afford.
 */
export interface PayableOrderView {
  id: string;
  customerUserId: string;
  status: string;
  grandTotal: number;
  currency: string;
  /**
   * The platform commission Module 06 already computed and **already charged the customer**
   * (`PricingCalculator`, module-06 §3.11 invariant 2 — it is a component of `grandTotal`). This
   * is the fee credited to `PLATFORM_REVENUE` at capture (BRULE-23, §11.3).
   *
   * Module 07 reads it rather than re-deriving a percentage at capture time. Re-deriving would
   * charge the pharmacy a fee the customer never paid whenever the configured rate changed
   * between checkout and fulfillment, and would put two independent formulas in charge of one
   * number. See `FeeCalculator` for the full rationale and the open configuration question.
   */
  platformFee: number;
  /**
   * The discount Module 06 already subtracted from `grandTotal` (`PricingCalculator`), in minor
   * units. Zero for an order with no coupon, which is every order today — Module 06's checkout
   * has no coupon step yet.
   *
   * ADR-019 resolved this as a **platform-funded** discount, so at capture it is the platform's
   * promotion expense: the pharmacy is paid as if no coupon existed and the platform absorbs the
   * difference. That makes this a leg of the capture posting, not a display figure — see
   * `FeeCalculator.splitCapture` and `CaptureAccountingService`.
   *
   * Read back from the order, never re-derived from `coupon_redemptions`. It is the same
   * discipline `platformFee` above follows and for the same reason: `grandTotal` was computed
   * from *this* number inside Module 06's checkout transaction, so any other value would produce
   * a posting that does not reconcile against the order the customer agreed to.
   */
  discountTotal: number;
  /** Module 06 Slice 1 marks every order COD; kept so the caller can reason about it. */
  isCod: boolean;
}

/**
 * One priced line of an order, as Module 06 froze it at checkout. Added by the coupon task: a
 * coupon applied to an order must be scored against the order's **own** lines, not against a cart
 * that may have changed since, and not against anything a request supplies.
 *
 * `unitPrice`/`lineTotal` are Module 06's committed figures, re-read rather than re-derived — the
 * same discipline `grandTotal` above follows. `pharmacyId` is written by the checkout saga from
 * Module 05's chosen match, which is what makes pharmacy-scoped coupons decidable on an order at
 * all; it is `null` only while a line is still unassigned.
 */
export interface PayableOrderLineView {
  catalogProductId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  pharmacyId: string | null;
}

/**
 * Cross-module read port into Module 06 — Orders (ADR-002). Own copy, not a cross-module import:
 * `OrdersModule` exports nothing, exactly like `CatalogModule`, so every consumer builds its own,
 * mirroring `modules/orders/application/ports/outbound/catalog.port.ts` and its Module 04/05
 * siblings. Backed by a direct, same-database `PrismaService` read of `orders` in the
 * infrastructure layer — never a Prisma relation.
 *
 * Read-only, and deliberately so: Module 07 never writes an order's status. Confirming an order
 * once its payment is authorized (BRULE-17) is Module 06's decision to make, through the inbound
 * `IPaymentAuthorizationPort` this module exports — see that port's doc comment.
 */
export interface IOrderPort {
  getOrder(orderId: string): Promise<PayableOrderView | null>;

  /** The order's priced lines, in creation order (§7's `order_lines`). */
  getOrderLines(orderId: string): Promise<PayableOrderLineView[]>;

  /**
   * The `Pharmacy.id`s fulfilling this order, in creation order — the owner of the
   * `PROVIDER_PAYABLE` account a capture credits (§11.3, BRULE-23).
   *
   * This is the only sound source for it: `Fulfillment.pharmacyId` is written by Module 06's
   * checkout saga from Module 05's chosen match, so it is platform-determined data, never
   * client-supplied. A capture must never accept a pharmacy id from its caller — that would let
   * a request redirect a payout.
   *
   * Slice 1 always produces exactly one fulfillment per order (module-06 §0.2 defers split
   * fulfillment), which is the shape §11.3's single-`PROVIDER_PAYABLE` posting assumes. The
   * caller rejects any other count rather than guessing how to divide one payment between
   * several pharmacies — the design defines no such split.
   */
  getFulfillmentPharmacyIds(orderId: string): Promise<string[]>;
}
