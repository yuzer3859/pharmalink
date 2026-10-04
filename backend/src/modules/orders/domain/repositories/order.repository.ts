import { OrderLineStatus, OrderStatus, OrderStrategy } from '../enums';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

/** Generic paged result, mirrors `modules/prescription-matching/domain/repositories/prescription
 * .repository.ts`'s per-module `PagedResult<T>` convention (not a shared cross-module type). */
export interface PagedResult<T> {
  items: T[];
  total: number;
}

/** `Order` aggregate root row (module-06 `06-orders-spec.md` §3.3). `paymentId` stays `null` for
 * every Slice-1 order (no Module 07); `isCod` is always `true` (§0.1). `beneficiarySnapshot` is
 * `null`, never an empty object (§13.4/§3.3 — forward-compat marker for a future Slice-2 reader).
 * `addressSnapshot`/`productSnapshot`-on-lines are frozen-at-write JSON, not VOs (§3.10). */
export interface OrderSnapshot {
  id: string;
  orderNumber: string;
  customerUserId: string;
  beneficiarySnapshot: Record<string, unknown> | null;
  addressSnapshot: Record<string, unknown> | null;
  status: OrderStatus;
  strategy: OrderStrategy;
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  grandTotal: number;
  currency: string;
  paymentId: string | null;
  matchRequestId: string | null;
  deliverySlot: string | null;
  idempotencyKey: string;
  isCod: boolean;
  placedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Child `OrderLine` row (§3.7). `prescriptionLineId` is populated only for Rx lines (the
 * `PrescriptionLine.id` `ICheckRxGatePort.check()` matched); `reservationId` comes from Module
 * 04's `IInventoryPort.reserve()` result — both are resolved by the caller (the checkout saga)
 * before calling this repository, which never talks to Module 04/05 itself. */
export interface OrderLineSnapshot {
  id: string;
  orderId: string;
  catalogProductId: string;
  productSnapshot: Record<string, unknown> | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  fulfillmentId: string | null;
  pharmacyId: string | null;
  branchId: string | null;
  reservationId: string | null;
  prescriptionLineId: string | null;
  requiresRx: boolean;
  lineStatus: OrderLineStatus;
  substitutedFromProductId: string | null;
  createdAt: Date;
}

/** One immutable `OrderStatusHistory` ledger row (§3.8, ADR-006 append-only-ledger discipline) —
 * one per `Order.status` transition, written in the same transaction as the status change. */
export interface OrderStatusHistoryEntrySnapshot {
  id: string;
  orderId: string;
  fromStatus: string | null;
  toStatus: string;
  event: string | null;
  actorUserId: string | null;
  actorRole: string | null;
  reason: string | null;
  createdAt: Date;
}

/** Data required to append one status-history row (§3.8, §3.11 invariant 3) — the caller
 * (`OrderStateMachine`-validated) already knows the transition; this shape carries nothing this
 * repository could derive on its own. */
export interface NewOrderStatusHistoryEntryData {
  fromStatus: string | null;
  toStatus: string;
  event?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  reason?: string | null;
}

/** `Invoice` entity row (§3.9) — a data-only row in Slice 1: `totals` is the computed JSON
 * snapshot at order placement, `pdfRef` always stays `null` (no `IStoragePort` exists, §0.2). */
export interface InvoiceSnapshot {
  id: string;
  orderId: string;
  invoiceNumber: string;
  pdfRef: string | null;
  totals: Record<string, unknown> | null;
  issuedAt: Date;
}

/** Data required to create the invoice row, written once at order placement, in the same
 * transaction as the order (§3.9). `totals` is `PricingCalculator.computeTotals()`'s output
 * (§3.11 invariant 2) — this repository does not compute it. */
export interface NewInvoiceData {
  invoiceNumber: string;
  totals: Record<string, unknown>;
}

/** Data required to create a brand-new `Order` header row (checkout saga §4 step 6). Created
 * directly at `status: PENDING_PAYMENT` (no separate `DRAFT` row is ever persisted in Slice 1 —
 * there is no "start of checkout" persistence step before the saga's own atomic step 6) — the
 * `initialHistoryEntry` param on `create()` below is what records that
 * `DRAFT -> PENDING_PAYMENT` transition (§3.4's first row), matching every other transition's
 * "no ad-hoc mutation without a history row" discipline (§3.11 invariant 3). */
export interface NewOrderData {
  orderNumber: string;
  customerUserId: string;
  beneficiarySnapshot: Record<string, unknown> | null;
  addressSnapshot: Record<string, unknown> | null;
  status: OrderStatus;
  strategy?: OrderStrategy;
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  grandTotal: number;
  currency?: string;
  matchRequestId?: string | null;
  deliverySlot?: string | null;
  idempotencyKey: string;
  isCod: boolean;
  placedAt?: Date | null;
}

/** Data required to insert one `OrderLine` (checkout saga §4 step 6) — created alongside the
 * order header, once, never re-created for an existing order. */
export interface NewOrderLineData {
  catalogProductId: string;
  productSnapshot?: Record<string, unknown> | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  fulfillmentId?: string | null;
  pharmacyId?: string | null;
  branchId?: string | null;
  reservationId?: string | null;
  prescriptionLineId?: string | null;
  requiresRx?: boolean;
  lineStatus?: OrderLineStatus;
}

/** Fields a validated (`OrderStatusPolicy`) status transition writes (§3.4, §3.5, §4 step 8,
 * §9.3 cancellation). The caller has already validated the transition via `OrderStatusPolicy`/
 * `CancellationPolicy` before calling this — this repository owns no state-machine logic. */
export interface OrderStatusUpdate {
  status: OrderStatus;
  placedAt?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
  matchRequestId?: string | null;
}

/** Data required to move one `OrderLine` from a declined `Fulfillment` onto the pharmacy a
 * re-match chose instead (`DeclineFulfillmentCommand`, §9.4, BR-ORD-14) — the caller (already
 * holding `IMatchingPort.rematch()`'s `chosenResult`) resolves the new pharmacy/branch/
 * reservation per line; this repository does not itself talk to Module 04/05. Added by the
 * Order/Fulfillment application-layer task — `IOrderRepository`'s original contract had no way to
 * reassign an already-created line onto a different `Fulfillment` post-decline. */
export interface OrderLineFulfillmentReassignment {
  fulfillmentId: string;
  pharmacyId: string;
  branchId: string;
  reservationId: string | null;
}

export interface ListOrdersCriteria {
  customerUserId: string;
  status?: OrderStatus;
  page: number;
  size: number;
}

/**
 * Persistence port for the `Order` aggregate root — `Order` header, its child `OrderLine` rows,
 * its append-only `OrderStatusHistory` ledger, and its 1:1 `Invoice` row (module-06
 * `06-orders-spec.md` §3.3/§3.7/§3.8/§3.9, §14 step 4). `Fulfillment` is deliberately **not**
 * covered here — see `IFulfillmentRepository`'s own doc comment for why it earns a separate
 * repository despite also being an `Order`-adjacent entity.
 *
 * `OrderStatusHistory` and `Invoice` are folded into this repository rather than given their own
 * (module-06 spec §14 step 4 names exactly three repositories: Cart/Order/Fulfillment) — mirrors
 * `IPrescriptionRepository.logAccess()`'s precedent (module-05 §11) of a child ledger/read-model
 * row living on its aggregate root's repository rather than earning a repository of its own
 * merely because it has its own database table (this task's own explicit instruction, §8/§20).
 *
 * `updateStatus` takes the history entry as a required parameter (not a separate call) so it is
 * impossible for a caller to persist a status change without the ledger row that must accompany
 * it in the same transaction (§3.11 invariant 3) — a stricter version of the discipline every
 * prior module's repository leaves to caller convention.
 *
 * `OrderStateMachine`/`CancellationPolicy` remain the sole authorities on which transitions are
 * legal — this repository persists whichever already-validated state the caller supplies.
 *
 * Every mutating method accepts an optional `tx` handle so the checkout saga can compose
 * `ICartRepository`/`IOrderRepository`/`IFulfillmentRepository` calls inside one `Serializable`
 * transaction (§4 step 6, §11) without any of these repositories knowing about that
 * orchestration themselves.
 */
export interface IOrderRepository {
  findById(id: string, tx?: unknown): Promise<OrderSnapshot | null>;
  findByOrderNumber(orderNumber: string, tx?: unknown): Promise<OrderSnapshot | null>;
  /** Idempotency-replay lookup (§4, §11, §13.5) — `Order.idempotencyKey`'s existing `@unique`
   * constraint is the DB-enforced backstop; a repeated `POST /checkout` with the same key is
   * resolved by re-reading and returning the already-committed order via this method, never by
   * creating a second row. */
  findByIdempotencyKey(idempotencyKey: string, tx?: unknown): Promise<OrderSnapshot | null>;
  listByCustomer(criteria: ListOrdersCriteria, tx?: unknown): Promise<PagedResult<OrderSnapshot>>;

  /** Creates the `Order` header row plus its initial `OrderStatusHistory` row (`DRAFT ->
   * PENDING_PAYMENT`, §3.4) in one write (checkout saga §4 step 6). `OrderLine`/`Fulfillment`/
   * `Invoice` rows are created via this repository's/`IFulfillmentRepository`'s own
   * `createLines`/`create`/`createInvoice` methods, composed by the caller inside the same `tx`
   * — this method does not bundle every child row into one giant call (§16's "do not create a
   * huge 'everything' aggregate interface"). */
  create(
    data: NewOrderData,
    initialHistoryEntry: NewOrderStatusHistoryEntryData,
    tx?: unknown,
  ): Promise<OrderSnapshot>;

  /** Validated (`OrderStatusPolicy`/`CancellationPolicy`) transitions only — see class doc. */
  updateStatus(
    id: string,
    update: OrderStatusUpdate,
    historyEntry: NewOrderStatusHistoryEntryData,
    tx?: unknown,
  ): Promise<void>;
  findStatusHistory(orderId: string, tx?: unknown): Promise<OrderStatusHistoryEntrySnapshot[]>;

  createLines(
    orderId: string,
    lines: NewOrderLineData[],
    tx?: unknown,
  ): Promise<OrderLineSnapshot[]>;
  findLinesByOrderId(orderId: string, tx?: unknown): Promise<OrderLineSnapshot[]>;
  /** Re-points an `OrderLine` at a re-matched `Fulfillment`/pharmacy/reservation
   * (`DeclineFulfillmentCommand`, §9.4, BR-ORD-14) — see `OrderLineFulfillmentReassignment`'s doc
   * comment. Never re-derives the new assignment itself; the caller supplies it verbatim. */
  updateLineFulfillment(
    orderLineId: string,
    data: OrderLineFulfillmentReassignment,
    tx?: unknown,
  ): Promise<void>;

  /** Written once, at order placement, in the same transaction as `create()` (§3.9). */
  createInvoice(orderId: string, data: NewInvoiceData, tx?: unknown): Promise<InvoiceSnapshot>;
  findInvoiceByOrderId(orderId: string, tx?: unknown): Promise<InvoiceSnapshot | null>;
}
