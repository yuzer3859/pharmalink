export const ORDER_CANCELLATION_REQUEST_REPOSITORY = Symbol('ORDER_CANCELLATION_REQUEST_REPOSITORY');

/** Mirrors the `OrderCancellationPhase` Postgres enum (Work 55). */
export const CancellationPhase = {
  REQUESTED: 'REQUESTED',
  STOCK_RELEASED: 'STOCK_RELEASED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
} as const;
export type CancellationPhase = (typeof CancellationPhase)[keyof typeof CancellationPhase];

/** Phases that still have work to do. */
export const OPEN_CANCELLATION_PHASES: readonly CancellationPhase[] = [
  CancellationPhase.REQUESTED,
  CancellationPhase.STOCK_RELEASED,
  CancellationPhase.ORDER_CANCELLED,
];

export interface CancellationRequestSnapshot {
  id: string;
  orderId: string;
  customerUserId: string;
  reason: string;
  phase: CancellationPhase;
  attempts: number;
  nextAttemptAt: Date;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  attentionRequiredAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/**
 * Persistence for durable customer-cancellation intent (Work 55). Every state change is a GUARDED
 * update — conditioned on the expected phase and, while working, on the caller's own lease — and
 * reports whether it applied, so two executors (a customer retry and the reconciler, or two
 * reconciler instances) can never both advance the same step.
 */
export interface IOrderCancellationRequestRepository {
  /**
   * Inserts the request already leased to `leaseOwner`, or — if one already exists for the order
   * (`orderId` is unique) — returns the existing row untouched. Runs inside the caller's transaction.
   */
  createOrGet(
    input: { orderId: string; customerUserId: string; reason: string; leaseOwner: string; leaseExpiresAt: Date },
    tx?: unknown,
  ): Promise<{ request: CancellationRequestSnapshot; created: boolean }>;
  findByOrderId(orderId: string, tx?: unknown): Promise<CancellationRequestSnapshot | null>;
  findById(id: string, tx?: unknown): Promise<CancellationRequestSnapshot | null>;
  /**
   * Takes the lease when the request is open and the lease is free or expired at `now`. With
   * `ignoreAttention: false` (the reconciler) a request flagged for attention is not taken; a
   * customer retry passes `true` and so may re-attempt it once.
   */
  claim(id: string, leaseOwner: string, now: Date, leaseExpiresAt: Date, ignoreAttention: boolean): Promise<boolean>;
  /** `phase = from` and `leaseOwner = owner` → `phase = to` (clearing error/attention; `COMPLETED`/`REJECTED` also end the lease). */
  advance(id: string, owner: string, from: CancellationPhase, to: CancellationPhase, now: Date, tx?: unknown, lastErrorCode?: string | null): Promise<boolean>;
  /** Records a transient failure: attempts + 1, the next retry time, the code; the lease ends. */
  scheduleRetry(id: string, owner: string, now: Date, nextAttemptAt: Date, errorCode: string): Promise<boolean>;
  /** Records a permanent failure (or exhausted retries): attention flagged, the code kept; the lease ends. */
  requireAttention(id: string, owner: string, now: Date, errorCode: string): Promise<boolean>;
  /** Ends the caller's lease without changing anything else. */
  releaseLease(id: string, owner: string): Promise<void>;
  /** Open, unflagged requests due at `now` with no live lease — oldest due first, bounded. */
  listDue(now: Date, limit: number): Promise<CancellationRequestSnapshot[]>;
}
