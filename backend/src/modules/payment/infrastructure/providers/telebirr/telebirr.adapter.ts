import { Injectable } from '@nestjs/common';
import {
  IPaymentProviderPort,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../../../application/ports/outbound/payment-provider.port';
import { PaymentMethod } from '../../../domain/enums';
import { PaymentErrors } from '../../../domain/errors';
import { TelebirrConfig } from './telebirr.config';

export const TELEBIRR_PROVIDER_KEY = 'telebirr';

/**
 * The exact provider facts this adapter needs before it can be implemented. Enumerated in code,
 * not just in a report, so the gap travels with the codebase and a future implementer sees it at
 * the point of work.
 */
export const TELEBIRR_MISSING_CONTRACT = [
  'API base URLs for sandbox and production',
  'authentication scheme for outbound calls (credential set, header/body placement, token lifecycle)',
  'request/response schema for initiating a payment',
  'whether Telebirr supports authorize-then-capture (a hold) or immediate charge only — the design\'s own Open Question 2',
  'capture request/response schema and semantics, if holds are supported',
  'void/cancel request/response schema and semantics, if holds are supported',
  'the provider-side idempotency mechanism (field name, uniqueness scope, retry semantics)',
  'callback delivery format, event vocabulary and event-identifier field',
  'callback signature algorithm, signed payload construction and signature header name',
  'refund request/response schema, including whether partial refunds are supported and how a refund is addressed (by the original transaction reference, by a refund identifier, or both)',
  'the refund-side idempotency mechanism, and whether a refund outcome is returned synchronously or only by callback',
  'payment status lookup endpoint and response schema, if one exists',
  'provider error/decline code catalogue',
  'sandbox credentials for integration testing',
] as const;

/**
 * `TelebirrAdapter` — **an explicitly unimplemented adapter, and deliberately so.**
 *
 * ## Why there is no integration here
 *
 * This repository contains no authoritative Telebirr contract. Every mention of Telebirr across
 * the requirements, the architecture and the code is a *name*: an enum value, a UI label, a
 * "process payments via e.g. Telebirr" requirement. The Module 07 design document does not
 * specify the integration either — it lists it as Open Question 1 ("confirm Telebirr + which
 * bank(s)/card processor + diaspora gateway; **each needs adapter + credentials**") and Open
 * Question 2 asks whether the chosen local providers "support holds (authorize) or only immediate
 * charge", which is the most basic question an adapter must answer.
 *
 * Writing endpoints, an auth scheme, a signature algorithm and request shapes from memory would
 * produce something that compiles, passes its own tests, and fails against the real gateway — or,
 * far worse, succeeds partially and moves real money in ways nobody specified. So this adapter
 * implements the port's *shape* and refuses every operation with a precise, actionable error.
 * {@link TELEBIRR_MISSING_CONTRACT} lists exactly what is needed to finish it.
 *
 * ## What it deliberately does not do
 *
 * It does not delegate to `MockPaymentProvider`, and it does not simulate success. A "Telebirr
 * adapter" that quietly answered `AUTHORIZED` would be indistinguishable from a working
 * integration in every test and dashboard, right up to the point where a customer's money was
 * involved. Failing loudly is the only safe behaviour for an unimplemented gateway.
 *
 * ## How it stays out of the way
 *
 * `isAvailable()` returns false, so `PaymentProviderRegistry` never routes to it: the rest of
 * Module 07 keeps working exactly as before, with `MockPaymentProvider` serving development and
 * tests (§13). The refusals below are reachable only by addressing this gateway explicitly —
 * which is what a payment already recorded as `provider: 'telebirr'` would do on capture, and
 * that too must fail rather than be silently rerouted.
 *
 * ## Method scope
 *
 * `supports()` claims `TELEBIRR` only. Nothing in the design says Telebirr handles bank, card or
 * cross-border payments (§10), and those have their own adapters in the design's own §10 folder
 * listing.
 */
@Injectable()
export class TelebirrAdapter implements IPaymentProviderPort {
  readonly key = TELEBIRR_PROVIDER_KEY;

  constructor(private readonly config: TelebirrConfig) {}

  supports(method: PaymentMethod): boolean {
    return method === PaymentMethod.TELEBIRR;
  }

  /**
   * Never available while the contract is missing — and it would still require complete
   * configuration afterwards. Both gates are expressed so that finishing the integration is a
   * matter of implementing the calls and flipping `CONTRACT_IMPLEMENTED`, with the configuration
   * check already in place.
   */
  isAvailable(): boolean {
    return TelebirrAdapter.CONTRACT_IMPLEMENTED && this.config.describe().complete;
  }

  /**
   * Flipped to `true` by the task that implements the real protocol. Kept as an explicit constant
   * rather than an implicit consequence of the code, so "is Telebirr live?" has one answer in one
   * place.
   */
  private static readonly CONTRACT_IMPLEMENTED = false;

  /**
   * The request's `paymentId` is the provider-side idempotency identity established by Task 2, and
   * it is what a real implementation must map onto Telebirr's own idempotency or merchant-reference
   * field — deterministically, so a retry of the same payment reaches the same gateway transaction.
   * Which field that is, is part of the missing contract.
   *
   * Parameters are omitted rather than bound: nothing here reads them, and a bound-but-unused
   * argument would only look like an implementation that forgot to use its input.
   */
  async authorize(): Promise<ProviderAuthorizationResult> {
    throw this.unavailable('authorize');
  }

  /**
   * Whether a capture step exists at all depends on the design's Open Question 2: if Telebirr is
   * charge-only, the normalization is auth+capture combined (§6's per-method note), not a separate
   * call. That is a product/provider decision, not one to guess here.
   */
  async capture(): Promise<ProviderCaptureResult> {
    throw this.unavailable('capture');
  }

  async voidAuthorization(): Promise<ProviderVoidResult> {
    throw this.unavailable('voidAuthorization');
  }

  /**
   * Refusing here is not merely consistent — it is the point. A refund moves real money *back* to
   * a customer, and a fabricated refund call would either silently do nothing while the platform
   * recorded a completed refund, or reach an endpoint that does something other than what was
   * assumed. `RefundPaymentCommand` treats a thrown provider error as an UNKNOWN outcome, so the
   * refund stays `PENDING` and no ledger posting is made: nothing is ever recorded as refunded
   * that was not actually refunded.
   */
  async refund(): Promise<ProviderRefundResult> {
    throw this.unavailable('refund');
  }

  /**
   * A hard refusal carrying the operation and the configuration gaps by **key name only** — never
   * a credential value, and never a fabricated provider message. `DEPENDENCY_UNAVAILABLE` is the
   * right category: the platform is fine, this gateway is not usable.
   */
  private unavailable(operation: string): Error {
    const state = this.config.describe();
    const error = PaymentErrors.providerContractUnavailable(this.key, operation);
    (error as { details?: unknown }).details = {
      provider: this.key,
      operation,
      reason: 'provider_contract_unavailable',
      enabled: state.enabled,
      missingConfigKeys: state.missing,
      missingContract: [...TELEBIRR_MISSING_CONTRACT],
    };
    return error;
  }
}
