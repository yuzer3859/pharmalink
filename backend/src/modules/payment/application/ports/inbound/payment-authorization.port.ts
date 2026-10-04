import { Injectable } from '@nestjs/common';
import {
  AuthorizePaymentCommand,
  AuthorizePaymentInput,
  AuthorizePaymentResult,
} from '../../commands/authorize-payment.command';
import {
  CapturePaymentCommand,
  CapturePaymentInput,
  CapturePaymentResult,
} from '../../commands/capture-payment.command';
import {
  VoidPaymentCommand,
  VoidPaymentInput,
  VoidPaymentResult,
} from '../../commands/void-payment.command';

export const PAYMENT_AUTHORIZATION_PORT = Symbol('PAYMENT_AUTHORIZATION_PORT');

/**
 * Module 07's exported contract for authorizing a payment, consumed in-process by other modules
 * via Nest DI, never over HTTP — the same inbound-port shape Module 04 exports as
 * `IInventoryPort` and Module 05 as `IMatchingPort` (ADR-002, module-04 §14.6).
 *
 * **This is the seam BRULE-17 will be satisfied through.** The design requires that "order
 * confirmation requires successful authorization", but Module 06 Slice 1 is COD-only: its
 * checkout saga has no payment step at all (`isCod = true`, `Order.paymentId` always `null`).
 * Rewriting that saga is explicitly a separate task, so this port is deliberately the *smallest*
 * thing that task will need — one method, the one operation it must perform — rather than a
 * speculative payment facade. Nothing consumes it yet; `PaymentModule` exports it so the
 * integration task can inject it into `CheckoutCommand` without any new contract work.
 *
 * The reverse direction stays read-only: Module 07 reads an order through its own `IOrderPort`
 * and never writes an order's status. Confirming an order once its payment is authorized remains
 * Module 06's decision, driven either by this port's return value or by the `payment.authorized`
 * event — that choice belongs to the integration task, not to this one.
 */
export interface IPaymentAuthorizationPort {
  authorize(input: AuthorizePaymentInput): Promise<AuthorizePaymentResult>;

  /**
   * Collects authorized funds at fulfillment (§11.3 — "Orders(6) OrderReady -> POST
   * /payments/{id}/capture"). Added by the capture/void task alongside `void` so the operations
   * Orders will drive are one contract rather than three. Still unwired: the Module 06
   * integration is a separate task.
   */
  capture(input: CapturePaymentInput): Promise<CapturePaymentResult>;

  /** Releases an authorization hold when an order is cancelled before capture (§6). */
  void(input: VoidPaymentInput): Promise<VoidPaymentResult>;
}

/**
 * Implements `IPaymentAuthorizationPort` as a thin facade over the already-tested
 * `AuthorizePaymentCommand` — a 1:1, unmodified delegation, owning no logic of its own. Mirrors
 * `MatchingPortAdapter`'s shape exactly; the facade exists only so the exported token is bound to
 * an interface rather than to a concrete command class.
 */
@Injectable()
export class PaymentAuthorizationPortAdapter implements IPaymentAuthorizationPort {
  constructor(
    private readonly authorizePaymentCommand: AuthorizePaymentCommand,
    private readonly capturePaymentCommand: CapturePaymentCommand,
    private readonly voidPaymentCommand: VoidPaymentCommand,
  ) {}

  authorize(input: AuthorizePaymentInput): Promise<AuthorizePaymentResult> {
    return this.authorizePaymentCommand.execute(input);
  }

  capture(input: CapturePaymentInput): Promise<CapturePaymentResult> {
    return this.capturePaymentCommand.execute(input);
  }

  void(input: VoidPaymentInput): Promise<VoidPaymentResult> {
    return this.voidPaymentCommand.execute(input);
  }
}
