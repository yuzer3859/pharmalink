import { PaymentProps } from '../entities/payment.entity';
import { PaymentMethod, PaymentStatus } from '../enums';

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

/**
 * Fields required to insert a brand-new `payments` row (§7). The caller supplies the `id` and an
 * already-validated aggregate state (`Payment.initiate(...).toProps()`), so the repository never
 * re-derives domain values.
 *
 * **PCI (BRULE-26, NFR-SEC-04): no field here carries card data.** `providerToken` is the opaque
 * token a PCI-DSS-compliant gateway issued in place of a card; `providerRef` is that gateway's
 * own transaction reference. There is no `pan`/`cardNumber`/`cvv`/`expiry` field, and adding one
 * would break the module's stated boundary.
 */
export interface NewPaymentData {
  id: string;
  orderId: string;
  customerUserId: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  currency: string;
  originalAmount?: number | null;
  originalCurrency?: string | null;
  fxRate?: number | null;
  fxSource?: string | null;
  provider?: string | null;
  providerRef?: string | null;
  providerToken?: string | null;
  idempotencyKey: string;
}

/**
 * Fields an already-validated (`PaymentStatusPolicy`) `Payment` transition writes. The state
 * machine lives in the domain — this repository persists whichever state the caller has already
 * proven legal, exactly as `IOrderRepository.updateStatus` does for Module 06.
 *
 * `authorizedAt`/`capturedAt` travel with the transition that sets them so a status change and
 * its timestamp can never be written apart from one another.
 */
export interface PaymentStateUpdate {
  status: PaymentStatus;
  providerRef?: string | null;
  authorizedAt?: Date | null;
  capturedAt?: Date | null;
  failureReason?: string | null;
}

/**
 * The filters a platform-wide payment read may narrow by (module-16 Work 07). Each is a column of
 * `payments` — nothing here is derived, and nothing searches free text. `createdFrom` is
 * inclusive and `createdTo` exclusive, so consecutive windows neither overlap nor leave a gap.
 */
export interface PaymentSearchCriteria {
  status?: PaymentStatus;
  method?: PaymentMethod;
  /** Exact match on the gateway key (`mock`, `telebirr`, …). */
  provider?: string;
  orderId?: string;
  customerUserId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface PaymentPage {
  items: PaymentProps[];
  total: number;
  page: number;
  size: number;
}

/**
 * `COUNT(*)` and `Σ amount` over the payments in one `(currency, status)` bucket.
 *
 * A sum of a column grouped by another column and nothing more: it does not net refunds, does
 * not subtract fees, and is not revenue — a `CAPTURED` bucket is "the amount of the payments the
 * gateway has captured and nothing has since refunded in full", exactly as `status` says.
 */
export interface PaymentStatusTotals {
  currency: string;
  status: PaymentStatus;
  count: number;
  amount: number;
}

/**
 * Persistence port for the `Payment` aggregate root (§5.1, §7). Domain-facing snapshots only, no
 * Prisma types (ADR-002). Every method accepts an optional `tx` handle so a payment command can
 * compose its payment write, its ledger posting, its audit entry and its outbox event inside one
 * `Serializable` transaction (ADR-010/ADR-013).
 *
 * `Refund`, `FraudFlag`, `ProviderWebhook`, `Coupon` and `Settlement` all have their own schema
 * tables already, and each earns its own repository in the task that builds it — they are
 * deliberately not folded into this contract.
 */
export interface IPaymentRepository {
  findById(id: string, tx?: unknown): Promise<PaymentProps | null>;

  /**
   * Idempotency-replay lookup (BRULE-25, §5.3). `payments.idempotencyKey` is `@unique`, so the
   * database is the final arbiter of "one key, one payment": a repeated authorize with the same
   * key is resolved by re-reading through this method and returning the already-committed
   * payment, never by inserting a second row. Mirrors
   * `IOrderRepository.findByIdempotencyKey`/`IReservationRepository.findByIdempotencyKey`.
   */
  findByIdempotencyKey(idempotencyKey: string, tx?: unknown): Promise<PaymentProps | null>;

  /** An order can accumulate several attempts (a failed authorization, then a successful one). */
  findByOrderId(orderId: string, tx?: unknown): Promise<PaymentProps[]>;

  /**
   * Locates a payment by the gateway's own reference. The fallback path when a callback echoes
   * only its own reference back and not our `paymentId` (§11.2). Scoped by `provider` because a
   * reference is only unique within one gateway's namespace.
   */
  findByProviderRef(
    provider: string,
    providerRef: string,
    tx?: unknown,
  ): Promise<PaymentProps | null>;

  /**
   * Payments sitting in a recoverable, non-terminal state since before `olderThan` — the input to
   * reconciliation (§3.6 F-REC-01). A payment left `INITIATED` by an async authorization, a
   * provider timeout or a crash between the gateway call and the local commit is exactly what
   * this finds; ordering is oldest-first so the longest-stuck are examined before the rest.
   */
  findStale(
    criteria: { statuses: PaymentStatus[]; olderThan: Date; limit: number },
    tx?: unknown,
  ): Promise<PaymentProps[]>;

  create(data: NewPaymentData, tx?: unknown): Promise<PaymentProps>;

  /** Persists a transition the domain has already validated; returns the committed row. */
  updateState(id: string, update: PaymentStateUpdate, tx?: unknown): Promise<PaymentProps>;

  /**
   * Platform-wide page, newest first (`createdAt desc, id desc` — the tie-break keeps two
   * payments created in the same millisecond in one order across pages). Added for module-16
   * Work 07's oversight read; nothing in this module's own flows lists across customers.
   */
  search(criteria: PaymentSearchCriteria, page: number, size: number, tx?: unknown): Promise<PaymentPage>;

  /**
   * Every `(currency, status)` bucket with its count and amount, in that order. Buckets with no
   * payments are absent rather than reported as zero.
   */
  summarizeByStatus(tx?: unknown): Promise<PaymentStatusTotals[]>;
}
