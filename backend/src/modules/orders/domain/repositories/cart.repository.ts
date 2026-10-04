import { CartStatus } from '../enums';

export const CART_REPOSITORY = Symbol('CART_REPOSITORY');

/** Child `CartItem` row (module-06 `06-orders-spec.md` §3.2). `requiresRx` is a cached copy of
 * `ICatalogPort.getProduct().rxClassification` at add-time (ADR-006 `sellable`-cache precedent)
 * — re-validated fresh at `/cart/validate` and at checkout, never trusted stale by any caller of
 * this repository. */
export interface CartItemSnapshot {
  id: string;
  cartId: string;
  catalogProductId: string;
  quantity: number;
  indicativePrice: number | null;
  requiresRx: boolean;
  addedAt: Date;
}

/** `Cart` aggregate root row plus its child items (§3.1/§3.2). Slice 1 collapses "one `ACTIVE`
 * cart per `(customerUserId, beneficiaryId)`" to "one `ACTIVE` cart per `customerUserId`" since
 * `beneficiaryId` is unenforced (§13.4) — `beneficiaryId` is still read back here (always `null`
 * in Slice 1) so a future Slice-2 reader isn't blocked by this repository's shape. */
export interface CartSnapshot {
  id: string;
  customerUserId: string;
  beneficiaryId: string | null;
  status: CartStatus;
  items: CartItemSnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

/** Data required to add a new line (`AddToCartCommand`, §9.1). `requiresRx`/`indicativePrice` are
 * resolved by the caller from a fresh `ICatalogPort.getProduct()` read before calling this —
 * this repository never queries Catalog itself (§0/§14: "do not put Catalog... business rules
 * into this repository"). */
export interface NewCartItemData {
  catalogProductId: string;
  quantity: number;
  indicativePrice?: number | null;
  requiresRx?: boolean;
}

/**
 * Persistence port for the `Cart` aggregate root plus its child `CartItem` rows (module-06
 * `06-orders-spec.md` §3.1/§3.2, §9.1, §14 step 4) — one repository for both, mirroring how
 * `IPrescriptionRepository`/`IMatchRepository` (module-05 §11) each own their child rows without
 * a separate child-entity repository.
 *
 * This repository persists the cart aggregate only — no Catalog/Inventory business rules (fresh
 * price/stock/Rx-classification revalidation) live here; that is `/cart/validate`'s
 * application-layer job (§0/§14).
 *
 * `CartItem`'s existing `@@unique([cartId, catalogProductId])` schema constraint is cart
 * mutations' actual concurrency-safety mechanism (§11) — no `Serializable` isolation is required
 * for cart writes alone; `addItem` is expected to be implemented as an upsert against that
 * constraint, not an insert-then-check race.
 *
 * Every mutating method accepts an optional `tx` handle so callers can compose calls inside a
 * transaction where needed (mirrors every Module 02-05 repository's `tx?: unknown` convention).
 */
export interface ICartRepository {
  /** One `ACTIVE` cart per customer in Slice 1 (§3.1, §13.4). */
  findActiveByCustomer(customerUserId: string, tx?: unknown): Promise<CartSnapshot | null>;
  findById(cartId: string, tx?: unknown): Promise<CartSnapshot | null>;
  /** Creates a brand-new `ACTIVE` cart — called only when `findActiveByCustomer` returns `null`. */
  create(customerUserId: string, tx?: unknown): Promise<CartSnapshot>;

  findItemById(cartItemId: string, tx?: unknown): Promise<CartItemSnapshot | null>;
  /** Upsert against `@@unique([cartId, catalogProductId])` (§11) — adding an already-present
   * product updates its existing row rather than racing a second insert. */
  addItem(cartId: string, item: NewCartItemData, tx?: unknown): Promise<CartItemSnapshot>;
  updateItemQuantity(
    cartItemId: string,
    quantity: number,
    tx?: unknown,
  ): Promise<CartItemSnapshot>;
  removeItem(cartItemId: string, tx?: unknown): Promise<void>;
  /**
   * Reconciles a line's cached `indicativePrice` to the current Catalog reference price
   * (parent doc F-CRT-06 "prices/stock refreshed; **stale prices reconciled**"; §9.1
   * `/cart/validate` "refresh prices/stock"). Called only by `/cart/validate` and
   * `/checkout/quote`, both of which report the change back to the customer as `priceChanged`
   * before writing it — never a silent background update, and never called by `/checkout`, which
   * must *compare* against the last confirmed price rather than overwrite it (§10
   * `PRICE_CHANGED`). Cached display metadata only; it is never the authoritative order price
   * (§3.12 invariant 2).
   */
  reconcileItemPrice(
    cartItemId: string,
    indicativePrice: number | null,
    requiresRx: boolean,
    tx?: unknown,
  ): Promise<CartItemSnapshot>;
  /** Removes every item, cart itself remains `ACTIVE` (`DELETE /cart`, §9.1). */
  clearItems(cartId: string, tx?: unknown): Promise<void>;

  /** Flips `status -> CONVERTED` once checkout succeeds (§3.1's schema-level `CartStatus`) — the
   * mechanism that lets `findActiveByCustomer` correctly start a fresh `ACTIVE` cart for the
   * customer's next shopping session rather than reusing an already-ordered one. Not a Slice-1
   * spec line item named verbatim, but required to keep §3.1's "one `ACTIVE` cart per customer"
   * invariant true across repeated checkouts — no `ABANDONED` transition is defined here (no
   * sweeper exists in Slice 1, mirrors §11's "no speculative sweeper" discipline). */
  markConverted(cartId: string, tx?: unknown): Promise<void>;
}
