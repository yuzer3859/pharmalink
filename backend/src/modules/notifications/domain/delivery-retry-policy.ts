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
