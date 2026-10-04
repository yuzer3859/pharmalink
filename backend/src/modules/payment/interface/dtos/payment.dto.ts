import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '../../domain/enums';

/**
 * `POST /payments/authorize` (§9.1's `{ orderId, method, amount, currency, token?, returnUrl? }`).
 *
 * ## What this DTO refuses to accept, and why
 *
 * There is no `customerUserId`, no `paymentId`, no `provider`, no `providerRef` and no `status`
 * field. The global `ValidationPipe` runs with `forbidNonWhitelisted: true`, so sending any of
 * them is a `400`, not a silently ignored extra — a client cannot pay on someone else's behalf,
 * choose its own payment id, name the gateway that will be recorded as holding the money, or
 * assert a payment state.
 *
 * `amount` and `currency` are accepted because §9.1's request shape includes them, but they are
 * **assertions to verify, not instructions**: `AuthorizePaymentCommand` compares them against the
 * order's own `grandTotal`/`currency` and rejects a mismatch. Nothing a client sends here decides
 * what is charged.
 */
export class AuthorizePaymentDto {
  /**
   * The order being paid. Deliberately `@IsString()` rather than `@IsUUID()`: order ids are
   * opaque cross-module references (ADR-002), and a format assertion here would be this module
   * asserting something about Module 06's id scheme that it does not own. Existence and
   * ownership are checked by the command against the real order.
   */
  @IsString()
  @MaxLength(64)
  orderId!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /** Integer minor units (ADR-005). Positive: authorizing zero is not a payment. */
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  /** ISO-4217, uppercase. The `Currency` value object re-validates it in the domain. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter uppercase ISO-4217 code' })
  currency?: string;

  /**
   * §9.1's `token?` — the opaque token a PCI-DSS-compliant gateway already issued in exchange for
   * the instrument. **Never card data** (BRULE-26): there is no PAN, CVV or expiry field on this
   * DTO and there never may be. Length-bounded only; its meaning belongs to the gateway.
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  token?: string;

  /**
   * Where a hosted/redirect flow returns the customer. Constrained to http(s) so it cannot be
   * used to hand the gateway a `javascript:` or `data:` target.
   */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  returnUrl?: string;
}

/**
 * `POST /payments/{id}/capture` (§9.1).
 *
 * Empty by design. The payment id comes from the route and everything else — the amount, the
 * currency, the gateway, the provider payable's owner — comes from the persisted authorized
 * payment and its order. Accepting an amount override would let a caller capture something other
 * than what was authorized, and partial capture is not defined anywhere in this design.
 *
 * `forbidNonWhitelisted` makes any supplied field a `400`, so this emptiness is enforced rather
 * than merely intended.
 */
export class CapturePaymentDto {}

/**
 * `POST /payments/{id}/void` (§9.1). No client-controlled monetary field: a void releases the
 * whole hold or nothing. Only a human-readable reason is accepted, for the audit trail.
 */
export class VoidPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
