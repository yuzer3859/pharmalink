import { PaymentStatus } from '../../../domain/enums';

export const PROVIDER_STATUS_PORT = Symbol('PROVIDER_STATUS_PORT');

/**
 * What a gateway says about a payment, normalized. `status` is `null` when the gateway itself
 * cannot say — which is a legitimate answer and must stay distinguishable from "it failed".
 */
export interface ProviderPaymentStatus {
  provider: string;
  /** The reference the lookup was made by. */
  providerRef: string | null;
  /**
   * The gateway's view mapped onto §6's states, or `null` when it has no confident answer (the
   * reference is unknown to it, or its own record is pending).
   */
  status: PaymentStatus | null;
  /** Sanitized, when the gateway explains a failure. */
  failureReason?: string | null;
}

/**
 * The smallest capability reconciliation needs from a gateway: **ask what happened to a payment**
 * (§3.6 F-REC-01).
 *
 * Kept as its own port rather than folded into `IPaymentProviderPort` because it is a distinct
 * capability with a distinct availability story — a gateway may support callbacks and charges
 * without exposing a status-lookup API, and a reconciliation sweeper must be able to run in a
 * degraded mode against the ones that do not.
 *
 * **No real adapter exists yet, deliberately.** Telebirr, bank, card and cross-border lookups
 * belong to the provider-adapter task; inventing their request/response shapes now would be
 * guessing at APIs nobody has read. What exists here is the seam those adapters plug into, and
 * `ReconciliationService` is written to work whether or not one is bound.
 */
export interface IProviderStatusPort {
  readonly provider: string;
  /** Looks a payment up by the gateway's own reference. */
  lookupPaymentStatus(input: {
    paymentId: string;
    providerRef: string | null;
  }): Promise<ProviderPaymentStatus>;
}

export const PROVIDER_STATUS_REGISTRY = Symbol('PROVIDER_STATUS_REGISTRY');

/** Selects a status-lookup adapter by gateway key; `null` when that gateway offers none. */
export interface IProviderStatusRegistry {
  forProvider(provider: string): IProviderStatusPort | null;
}
