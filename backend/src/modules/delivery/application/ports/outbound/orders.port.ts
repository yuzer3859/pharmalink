export const ORDERS_PORT = Symbol('DELIVERY_ORDERS_PORT');

/** One line of the fulfillment, as delivery needs to see it. */
export interface DeliverableLineView {
  catalogProductId: string;
  /** From `OrderLine.productSnapshot` — the name as it read when the order was placed. */
  name: string;
  quantity: number;
}

/**
 * Everything Module 08 needs from Module 06 to cut a delivery job, and nothing else.
 *
 * Deliberately **not** the `Fulfillment` or `Order` aggregate. Module 08 must not hold a copy of
 * another context's aggregate: it would acquire fields it has no business knowing (pricing,
 * payment ids, Rx classification) and would drift the moment Module 06 changed. This view is the
 * projection delivery actually consumes.
 *
 * `dropoff` comes from **`Order.addressSnapshot`**, not from a live Module 02 read, and that is a
 * correctness decision rather than a convenience. The snapshot is the address the order was
 * *placed against*, frozen by Module 06 at checkout; a customer who edits their address afterwards
 * must not retroactively redirect a delivery they already ordered. It is also the only thing
 * available — `orders` stores no `addressId`, only the snapshot, so there is no id with which
 * Module 02 could be asked.
 */
export interface DeliverableFulfillmentView {
  fulfillmentId: string;
  orderId: string;
  pharmacyId: string;
  branchId: string;
  /** Module 06's `FulfillmentStatus`, as a plain string — Module 08 owns no order state machine. */
  status: string;
  /** `true` when the fulfillment is in the one state from which a job may be cut (BRULE-27). */
  isReadyForDelivery: boolean;
  /** An existing job's id, when Module 06 already recorded one (`Fulfillment.deliveryJobId`). */
  deliveryJobId: string | null;
  isCod: boolean;
  /** `Order.grandTotal` in minor units (ADR-005) — what a COD driver collects. */
  orderTotal: number;
  /**
   * `Order.deliveryFee` in minor units — **the delivery charge the customer actually paid**.
   *
   * Read rather than recomputed, and read from Module 06 rather than kept here, because Module 06
   * froze it inside its checkout transaction and that frozen number is the one the customer
   * agreed to. Module 08 calculated it (`DeliveryFeePolicy`, through `IDeliveryPricingPort`) and
   * then stopped owning it the moment it became a line on an order — which is the whole shape of
   * the boundary: Delivery supplies the calculation, Module 06 owns the charge.
   *
   * It comes back across the port so the job can snapshot it, for the reason `DeliveryJobProps.deliveryFee`
   * sets out: the delivery context needs to answer what a completed delivery was worth without
   * reaching into another module on every read, and the work that computes driver earnings must
   * not have to reverse-engineer a historical fee out of today's rate card.
   */
  deliveryFee: number;
  currency: string;
  dropoff: {
    lat: number | null;
    lng: number | null;
    line1: string | null;
    city: string | null;
  } | null;
  lines: DeliverableLineView[];
}

/**
 * Cross-module read port into Module 06 — Cart, Checkout & Orders
 * (`architecture/module-08-delivery-tracking.md` §10's `IOrdersPort`). Own copy per ADR-002, not
 * an import of Module 06's repositories: `OrdersModule` exports nothing, and Module 08 reads the
 * same database directly in its infrastructure layer — never through a Prisma relation.
 *
 * **Read-only, and it must stay that way.** §1's boundary gives order state to Module 06; Module
 * 08 reports what happened and lets Module 06 advance its own aggregate from the resulting event.
 * There is deliberately no `markDispatched` here, and adding one would be the first step in
 * Module 08 owning a state machine it does not own.
 */
export interface IOrdersPort {
  /**
   * The fulfillment's delivery-relevant projection, or `null` when it does not exist.
   *
   * Eligibility is *reported* (`isReadyForDelivery`), not enforced here: this port answers a data
   * question, and the decision to refuse belongs to the command that has the error vocabulary.
   * The port does decide what "ready" means, though, because that is Module 06's rule to state
   * and Module 08 must not re-derive it from a status string.
   */
  getDeliverableFulfillment(fulfillmentId: string): Promise<DeliverableFulfillmentView | null>;

  /**
   * The Module 01 `users.id` of the customer an order belongs to, or `null` when the order does
   * not exist (§9.4's "Auth: order ownership").
   *
   * ## Why this is here rather than read directly
   *
   * Live tracking is the first Module 08 surface a **customer** touches, and it needs an answer
   * Module 08 has no business deriving: whose order is this? `delivery_jobs` carries an `orderId`
   * and nothing else about the buyer, and it should stay that way — copying `customerUserId` into
   * the delivery aggregate would mirror an authorization fact into a second home, which is the
   * mistake the driver-profile work refused to make with Module 01's verification state and for
   * the same reason. A mirrored authorization fact fails open: the copy that missed an update
   * grants access the authority would have denied.
   *
   * So the question is asked, every time, of the module that owns the answer.
   *
   * ## Why it returns an id rather than a boolean
   *
   * `isOwnedBy(orderId, userId)` would read more directly, and it is the wrong shape. A port that
   * takes the identity being checked invites a caller to pass the identity it was *given* rather
   * than the one it *authenticated*, and the whole point of §5 is that a customer-supplied id is
   * not proof of anything. Returning the owner forces the comparison to happen in the caller,
   * against the subject resolved from the access token, where it can be read and reviewed.
   *
   * The id is not customer data leaving Module 06 in any meaningful sense — it is the same
   * `users.id` the caller already holds from the token, and it never reaches a response body.
   */
  getOrderCustomerUserId(orderId: string): Promise<string | null>;
}
