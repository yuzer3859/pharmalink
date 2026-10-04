import { Injectable } from '@nestjs/common';
import { PaymentMethod } from '../../domain/enums';
import {
  IPaymentProviderPort,
  ProviderAuthorizationRequest,
  ProviderAuthorizationResult,
  ProviderCaptureResult,
  ProviderPaymentOperationRequest,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderVoidResult,
} from '../../application/ports/outbound/payment-provider.port';

/**
 * Methods a gateway adapter can authorize. `COD` and `WALLET` are excluded on purpose: neither
 * involves an external gateway at all (cash is collected on delivery, §3.1 F-PAY-06; a wallet
 * spend is an internal ledger movement, §11.6). Routing either through a provider would be
 * wrong, so `supports()` reports false and `AuthorizePaymentCommand` rejects them cleanly rather
 * than inventing a gateway round-trip. Their own flows are separate tasks.
 */
const GATEWAY_METHODS: ReadonlySet<PaymentMethod> = new Set([
  PaymentMethod.TELEBIRR,
  PaymentMethod.CARD,
  PaymentMethod.BANK_TRANSFER,
  PaymentMethod.CROSS_BORDER,
]);

/**
 * `MockPaymentProvider` (§10's own `infrastructure/providers/` listing) — a deterministic,
 * in-process stand-in for a real gateway. It performs **no network I/O whatsoever**.
 *
 * It exists so the authorization flow can be wired, exercised and tested end-to-end before any
 * real gateway credentials exist, in exactly the same spirit as the project's other
 * non-production adapters (the in-memory OTP store and the mock Fayda provider, which
 * `test/support/test-app.ts` documents as "the project's non-production adapters, used as-is, so
 * the wiring under test is the wiring that ships").
 *
 * Behaviour, chosen to make both §6 authorization branches reachable without a test override:
 *  - a request carrying a `returnUrl` is treated as a hosted/redirect flow and returns `PENDING`
 *    with a redirect, so the async path is real rather than hypothetical;
 *  - anything else authorizes synchronously.
 *
 * It never returns `FAILED` on its own — a decline is not something a stub should decide. Tests
 * that need the failure branch bind their own scripted double to `PAYMENT_PROVIDER_PORT`.
 *
 * **This is not a production adapter.** Telebirr, bank, card and cross-border adapters are the
 * provider-adapter task; each will implement this same port, and the strategy selection that
 * picks between several bound providers by method arrives with them. Until then exactly one
 * provider is bound and `supports()` is the whole capability check.
 *
 * PCI (BRULE-26): it receives no card data — only the opaque `providerToken` the port allows —
 * and it neither stores nor logs anything.
 */
@Injectable()
export class MockPaymentProvider implements IPaymentProviderPort {
  readonly key = 'mock';

  supports(method: PaymentMethod): boolean {
    return GATEWAY_METHODS.has(method);
  }

  async authorize(request: ProviderAuthorizationRequest): Promise<ProviderAuthorizationResult> {
    // Derived from our own `paymentId`, which is exactly how a real gateway's idempotency works:
    // re-authorizing the same payment yields the same reference rather than a second hold.
    const providerRef = `mock-auth-${request.paymentId}`;

    if (request.returnUrl) {
      return {
        outcome: 'PENDING',
        providerRef,
        redirectUrl: `${request.returnUrl}${request.returnUrl.includes('?') ? '&' : '?'}ref=${providerRef}`,
      };
    }

    return { outcome: 'AUTHORIZED', providerRef };
  }

  /**
   * Collects the authorized funds. Idempotent on `paymentId` by construction: the reference is
   * derived from it, and the stub holds no state that a second call could double-charge — which
   * is the behaviour the port requires of every real adapter too.
   */
  async capture(request: ProviderPaymentOperationRequest): Promise<ProviderCaptureResult> {
    return { outcome: 'CAPTURED', providerRef: `mock-capture-${request.paymentId}` };
  }

  /** Releases the hold. A real void, never a capture-then-refund (see the port's contract). */
  async voidAuthorization(request: ProviderPaymentOperationRequest): Promise<ProviderVoidResult> {
    return { outcome: 'VOIDED', providerRef: `mock-void-${request.paymentId}` };
  }

  /**
   * Returns captured funds (§11.4). Idempotent on `refundId` by construction: the reference is
   * derived from it, and the stub holds no state a second call could pay out twice — which is the
   * behaviour the port requires of every real adapter too.
   *
   * Note the reference is derived from `refundId`, not `paymentId`: a payment may have several
   * legitimate partial refunds, and giving them one shared reference would make them
   * indistinguishable in reconciliation.
   */
  async refund(request: ProviderRefundRequest): Promise<ProviderRefundResult> {
    return { outcome: 'REFUNDED', providerRef: `mock-refund-${request.refundId}` };
  }
}
