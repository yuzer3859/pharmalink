/**
 * Delivery queue policy (module-13 Work 13): every number the dispatcher and its scheduler use, in
 * one place, so changing a delay or a batch size never means editing the dispatcher.
 */
export const DELIVERY_QUEUE_POLICY = Object.freeze({
  /** Provider attempts per job, the first included. The fifth failure exhausts the job. */
  maxProviderAttempts: 5,
  /**
   * Delay before the next attempt after the n-th failure (index n - 1): 30 s, 2 min, 10 min,
   * 30 min. No jitter. There is no entry for the fifth failure — it is terminal.
   */
  retryDelaysMs: Object.freeze([30_000, 120_000, 600_000, 1_800_000]),
  /**
   * How long a claim lasts. A job left `PROCESSING` past this (a worker died mid-send) becomes
   * claimable again. Generous against a provider round-trip; a provider must time out well within it.
   */
  leaseMs: 120_000,
  /**
   * When a bound provider reports itself not configured, the job goes back to `PENDING` this far in
   * the future — no attempt recorded, no retry consumed — rather than being re-claimed every tick.
   */
  notConfiguredRecheckMs: 300_000,
  /** Scheduler tick. */
  dispatchIntervalMs: 5_000,
  /** Jobs one tick may claim. More wait for the next tick. */
  dispatchBatchSize: 20,
});

/**
 * When to try again after the `failedAttempts`-th provider failure, or `null` when that failure
 * exhausts the job.
 */
export function retryDelayAfter(failedAttempts: number): number | null {
  if (failedAttempts >= DELIVERY_QUEUE_POLICY.maxProviderAttempts) return null;
  return DELIVERY_QUEUE_POLICY.retryDelaysMs[Math.max(failedAttempts, 1) - 1] ?? null;
}

/**
 * Push delivery bounds (module-13 Work 14). A push to a user is one OAuth token exchange (only
 * when the cached access token is stale) followed by one request per device, sent in parallel —
 * each request with its own timeout. Worst case: `requestTimeoutMs` (token) + `requestTimeoutMs`
 * (sends) = 20 s, and `deliveryDeadlineMs` caps the whole call regardless; both are far inside the
 * 120 s claim lease, so a slow push service can never outlive its lease and be sent twice.
 */
export const PUSH_DELIVERY_POLICY = Object.freeze({
  /** Per HTTP request to the push service or its OAuth endpoint. */
  requestTimeoutMs: 10_000,
  /** Hard cap on one logical push delivery, whatever the transport does. */
  deliveryDeadlineMs: 30_000,
  /** Devices one notification is pushed to: the user's most recently seen active registrations. */
  maxDevicesPerDelivery: 10,
});

/**
 * SMS delivery bounds (module-13 Work 15). One gateway request per notification;
 * `deliveryDeadlineMs` caps it whatever the transport does — far inside the 120 s claim lease.
 */
export const SMS_DELIVERY_POLICY = Object.freeze({
  /** Passed to the transport for its HTTP request. */
  requestTimeoutMs: 10_000,
  /** Hard cap on one SMS delivery. */
  deliveryDeadlineMs: 30_000,
});

/**
 * E-mail delivery bounds (module-13 Work 16). One provider request per notification — allowed a
 * little longer than an SMS request, since mail relays are slower to accept — and
 * `deliveryDeadlineMs` caps it whatever the transport does, far inside the 120 s claim lease.
 */
export const EMAIL_DELIVERY_POLICY = Object.freeze({
  /** Passed to the transport for its request. */
  requestTimeoutMs: 15_000,
  /** Hard cap on one e-mail delivery. */
  deliveryDeadlineMs: 30_000,
});
