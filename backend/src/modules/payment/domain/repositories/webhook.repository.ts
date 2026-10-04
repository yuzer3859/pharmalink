export const WEBHOOK_REPOSITORY = Symbol('WEBHOOK_REPOSITORY');

/**
 * A `provider_webhooks` row (§7). `payload` is the **only** place in this module where a raw
 * gateway payload is stored, exactly as the design sanctions — it never reaches a domain entity,
 * a ledger API, an audit context or an outbox event (§12).
 */
export interface ProviderWebhookSnapshot {
  id: string;
  provider: string;
  eventId: string;
  payload: unknown;
  /** `null` until the callback's business effects have committed. */
  processedAt: Date | null;
  createdAt: Date;
}

export interface NewProviderWebhookData {
  provider: string;
  eventId: string;
  /** The parsed raw payload, stored verbatim for reconciliation and forensics. */
  payload: unknown;
  /** Set when the row is written in the same transaction as its business effects. */
  processedAt?: Date | null;
}

/**
 * Persistence port for provider callbacks (§7, §10 `IWebhookRepository`).
 *
 * **The deduplication guarantee is the database's, not this interface's.**
 * `provider_webhooks` carries `@@unique([provider, eventId])`, which is what actually makes
 * "processed at most once per provider" true under concurrent delivery — two simultaneous copies
 * of one callback race to `record()`, exactly one wins, and the loser's `P2002` is the signal to
 * treat its delivery as a replay. An application-level "have I seen this?" check before the
 * insert cannot provide that, because both requests would pass it.
 *
 * The `eventId` namespace is per provider, so two gateways may legitimately issue the same event
 * id; the composite key is what keeps them apart.
 */
export interface IWebhookRepository {
  findByProviderEvent(
    provider: string,
    eventId: string,
    tx?: unknown,
  ): Promise<ProviderWebhookSnapshot | null>;

  /**
   * Inserts the callback record. Throws Prisma's `P2002` when this `(provider, eventId)` has
   * already been recorded — the caller treats that as "another delivery of this event got here
   * first", never as a failure.
   */
  record(data: NewProviderWebhookData, tx?: unknown): Promise<ProviderWebhookSnapshot>;

  /** Stamps `processedAt`, marking the callback's business effects as committed. */
  markProcessed(id: string, processedAt: Date, tx?: unknown): Promise<void>;

  /**
   * Callbacks recorded but never completed — a delivery whose business processing failed after
   * the row was written. Reconciliation input (§3.6 F-REC-01); no scheduler consumes it yet.
   */
  findUnprocessed(limit: number, tx?: unknown): Promise<ProviderWebhookSnapshot[]>;
}
