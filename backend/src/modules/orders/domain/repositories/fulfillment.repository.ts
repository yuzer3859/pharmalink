import { FulfillmentStatus } from '../enums';
import { PagedResult } from './order.repository';

export const FULFILLMENT_REPOSITORY = Symbol('FULFILLMENT_REPOSITORY');

/** `Fulfillment` entity row (module-06 `06-orders-spec.md` §3.6). Exactly one per `Order` in
 * Slice 1 (split fulfillment deferred, §0.2) — created at order-placement time from the single
 * `MatchRequest.chosenResult` (Module 05). Addressed directly by its own id in every pharmacy
 * route (§9.4's `/pharmacy/orders/:fulfillmentId/...`), which is why it is its own repository
 * rather than a method group buried inside `IOrderRepository` (§14 step 4 names it as its own
 * contract, distinct from `ICartRepository`/`IOrderRepository`). */
export interface FulfillmentSnapshot {
  id: string;
  orderId: string;
  pharmacyId: string;
  branchId: string;
  status: FulfillmentStatus;
  deliveryJobId: string | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  createdAt: Date;
}

/** Data required to create the Slice-1 single `Fulfillment` for an order (checkout saga §4 step
 * 6), resolved by the caller from Module 05's `MatchRequest.chosenResult` (§3.6/§3.7) — this
 * repository does not itself know about `MatchRequest`. */
export interface NewFulfillmentData {
  orderId: string;
  pharmacyId: string;
  branchId: string;
  status?: FulfillmentStatus;
}

/** Fields a validated (`FulfillmentStatusPolicy`) status transition writes (§3.6, §9.4 accept/
 * decline/prepare/ready). The caller has already validated the transition itself before calling
 * this — this repository owns no state-machine logic (`FulfillmentStatusPolicy` remains the
 * domain authority, per this task's own boundary). */
export interface FulfillmentStatusUpdate {
  status: FulfillmentStatus;
  acceptedAt?: Date | null;
  readyAt?: Date | null;
  deliveryJobId?: string | null;
}

export interface ListFulfillmentsByPharmacyCriteria {
  /** Resolved by the caller from `IIdentityPort.getUserOrganizationIds()` (§9.4) — this
   * repository does not call Identity itself. */
  pharmacyIds: string[];
  status?: FulfillmentStatus;
  page: number;
  size: number;
}

/**
 * Persistence port for the `Fulfillment` entity (module-06 `06-orders-spec.md` §3.6, §9.4, §14
 * step 4). `Fulfillment` is a child of the `Order` aggregate (order lifecycle, cancellation, and
 * totals remain `IOrderRepository`'s concern), but is queried/mutated independently here because
 * every pharmacy-facing route addresses it directly by `fulfillmentId`, never by `orderId`
 * (§9.4) — mirroring how Module 05 gave `MatchRequest` its own `IMatchRepository` despite being
 * conceptually order-adjacent, because it has its own independent lifecycle and access pattern.
 *
 * `FulfillmentStatusPolicy` remains the sole authority on which transitions are legal — this
 * repository persists whichever already-validated state the caller supplies, never re-deriving
 * or re-checking it.
 *
 * Every mutating method accepts an optional `tx` handle so accept/decline/prepare/ready commands
 * can compose this repository's calls with `IOrderRepository`'s (e.g. cascading `Order.status ->
 * READY` once every fulfillment reaches `READY`, §3.11 invariant 4) inside one `Serializable`
 * transaction (§11), without this repository knowing about that orchestration itself.
 */
export interface IFulfillmentRepository {
  findById(id: string, tx?: unknown): Promise<FulfillmentSnapshot | null>;
  findByOrderId(orderId: string, tx?: unknown): Promise<FulfillmentSnapshot[]>;
  /** Creates the Slice-1 single fulfillment row (checkout saga §4 step 6). */
  create(data: NewFulfillmentData, tx?: unknown): Promise<FulfillmentSnapshot>;
  updateStatus(id: string, update: FulfillmentStatusUpdate, tx?: unknown): Promise<void>;
  /** Backs `GET /pharmacy/orders` (§9.4), org-scoped by the caller-resolved `pharmacyIds`. */
  listByPharmacyIds(
    criteria: ListFulfillmentsByPharmacyCriteria,
    tx?: unknown,
  ): Promise<PagedResult<FulfillmentSnapshot>>;
}
