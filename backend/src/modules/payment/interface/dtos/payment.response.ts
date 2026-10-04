import { AuthorizePaymentResult } from '../../application/commands/authorize-payment.command';
import { CapturePaymentResult } from '../../application/commands/capture-payment.command';
import { VoidPaymentResult } from '../../application/commands/void-payment.command';
import { PaymentStatus } from '../../domain/enums';

/**
 * §9.1's documented response: `{ paymentId, status, providerRedirect? }`, plus the amount the
 * client needs to display.
 *
 * The command's result carries a little more than a client should see, so these mappers are an
 * explicit allow-list rather than a pass-through. In particular `providerRef` is **not** returned
 * from a mutation: it is available on `GET /payments/{id}`, where the caller has been
 * ownership-checked, whereas an authorize response can be triggered by anyone who can create a
 * payment. Keeping the surfaces distinct means a change to the command's result shape cannot
 * silently widen what an endpoint exposes.
 */
export interface AuthorizePaymentResponse {
  paymentId: string;
  status: PaymentStatus;
  /** Present only for an async/redirect flow; `null` when funds are already held. */
  providerRedirect: string | null;
  amount: number;
  currency: string;
  /** `true` when an already-committed payment was returned rather than a new one created. */
  replay: boolean;
}

export function toAuthorizeResponse(result: AuthorizePaymentResult): AuthorizePaymentResponse {
  return {
    paymentId: result.paymentId,
    status: result.status,
    providerRedirect: result.providerRedirect,
    amount: result.amount,
    currency: result.currency,
    replay: result.replay,
  };
}

export interface CapturePaymentResponse {
  paymentId: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  /** Platform commission credited to `PLATFORM_REVENUE` (BRULE-23). */
  fee: number;
  /**
   * Credited to the provider's `PROVIDER_PAYABLE`. Under ADR-019's platform-funded coupons this is
   * `amount - fee + promotionExpense`, so it can exceed `amount - fee`: the pharmacy is paid as
   * though no coupon had been used.
   */
  providerNet: number;
  /**
   * The platform-funded coupon discount debited to `PROMOTION_EXPENSE` (ADR-019). Exposed so the
   * three figures reconcile on their face — without it `providerNet` looks larger than the money
   * that came in, for no visible reason. `0` for an order with no coupon.
   */
  promotionExpense: number;
  replay: boolean;
}

export function toCaptureResponse(result: CapturePaymentResult): CapturePaymentResponse {
  return {
    paymentId: result.paymentId,
    status: result.status,
    amount: result.amount,
    currency: result.currency,
    fee: result.fee,
    providerNet: result.providerNet,
    promotionExpense: result.promotionExpense,
    replay: result.replay,
    // `ledgerReference` is deliberately omitted: it is an internal bookkeeping handle, and §11's
    // rule is that ledger internals do not cross the HTTP boundary.
  };
}

export interface VoidPaymentResponse {
  paymentId: string;
  status: PaymentStatus;
  replay: boolean;
}

export function toVoidResponse(result: VoidPaymentResult): VoidPaymentResponse {
  return {
    paymentId: result.paymentId,
    status: result.status,
    replay: result.replay,
  };
}
