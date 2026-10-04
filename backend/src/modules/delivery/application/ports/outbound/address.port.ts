export const ADDRESS_PORT = Symbol('DELIVERY_ADDRESS_PORT');

/** A destination, as delivery pricing needs it: where it is, and enough to label it. */
export interface DeliveryAddressView {
  lat: number | null;
  lng: number | null;
  line1: string | null;
  city: string | null;
}

/**
 * Cross-module read port into Module 02 — Profiles. Own copy per ADR-002, mirroring the copy
 * Module 06 keeps: `ProfilesModule` exports nothing, so each consumer builds its own narrow
 * adapter over the same database rather than sharing one — never a Prisma relation.
 *
 * ## Why delivery needs an address read at all, when jobs already carry a snapshot
 *
 * Because a **quote happens before the order does**. `IOrdersPort` answers "where was this order
 * going", which is the right question once a job exists and the wrong one at checkout, when there
 * is no order, no fulfillment and no job — only a customer choosing between pharmacies and asking
 * what delivery will cost. This port answers that earlier question, and it is the only reason it
 * exists; nothing in the job lifecycle uses it.
 *
 * The two sources stay in their lanes, and the lane matters: a delivery that has already been
 * priced is priced against `Order.addressSnapshot` forever, because a customer editing their
 * address afterwards must not retroactively re-price a delivery they have already been charged
 * for.
 *
 * ## Ownership is enforced inside the query, not by the caller
 *
 * `customerUserId` is required and is applied as a filter, not checked afterwards, so this port
 * structurally cannot return another customer's address. A mismatched id is indistinguishable from
 * a genuine miss — no existence leakage (`00-shared-conventions.md` §1) — which is what stops the
 * quote route from becoming a way to test whether a given address id belongs to somebody.
 *
 * Four fields, and no more. `recipientPhone` and the rest of the row are PII that a delivery quote
 * has no use for, and a field that is not projected cannot leak.
 */
export interface IAddressPort {
  getAddress(addressId: string, customerUserId: string): Promise<DeliveryAddressView | null>;
}
