import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { RefundDestination } from '../../domain/enums';

/** A JSON body may legitimately carry an integer as a string; nothing else converts to money. */
const INTEGER_TEXT = /^-?\d+$/;

/**
 * `POST /payments/{id}/refunds` — §9.3's `{ amount?, reason, destination }`.
 *
 * ## What this DTO refuses to accept, and why
 *
 * There is no `customerUserId`, no `refundId`, no `paymentId`, no `provider`, no `providerRef`,
 * no `status` and no `approvedBy` field. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted: true`, so sending any of them is a `400` rather than a silently dropped
 * extra — a client cannot choose the refund's id, assert a refund or payment state, name the
 * gateway reference that will be recorded, or nominate who approved it. The approver is the
 * authenticated caller, taken from the verified token by the controller; the payment id comes
 * only from the route.
 *
 * There is likewise no `currency`. `RefundPaymentInput` accepts one as an assertion to verify,
 * but a refund is settled in the payment's own currency and nothing over HTTP needs to restate
 * it — omitting the field removes the possibility of a mismatch entirely rather than relying on
 * the check.
 *
 * Nothing here decides the internal accounting. ADR-016's fee clawback is computed from the legs
 * the capture actually posted; no field on this DTO can influence it.
 */
export class RefundPaymentDto {
  /**
   * §9.3's `amount?` — **omitted means refund everything still refundable**. Integer minor units
   * (ADR-005), positive: refunding zero is not a refund, and a fractional amount is not money.
   *
   * The remaining amount is deliberately *not* computed here. `RefundPaymentCommand` derives it
   * from `captured - Σ refunds` inside the same `Serializable` transaction that inserts the
   * refund row, which is what makes BRULE-24's over-refund invariant hold under concurrency; a
   * figure computed in a controller would be stale before it was used.
   *
   * The `@Transform` reads the **raw** value, converting only a string of digits. Left to the
   * global pipe's `enableImplicitConversion`, this property would be coerced to its reflected
   * `Number` type first — and `true` would arrive as `1`, a one-santim refund nobody asked for.
   * Reading the raw value keeps `@IsInt` a real check while still accepting `"250"`, which is
   * what every other payment DTO's amount accepts today.
   */
  @IsOptional()
  @Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>).amount;
    return typeof raw === 'string' && INTEGER_TEXT.test(raw.trim()) ? Number(raw) : raw;
  })
  @IsInt()
  @Min(1)
  amount?: number;

  /**
   * Why the money is going back. Required by §9.3's body shape, and required in substance too:
   * it is one of §13's audited refund fields, and a refund with no recorded reason cannot be
   * reviewed after the fact.
   *
   * Bounded at 500 characters, matching `VoidPaymentDto.reason` — `refunds.reason` is an
   * unbounded `String?` in Postgres, so the limit exists here, at the edge, rather than as a
   * database truncation.
   *
   * The `@Transform` reads the **raw** value off the incoming payload. Without it the global
   * pipe's `enableImplicitConversion` would coerce this property to its reflected `String` type
   * first, so `42` would arrive as `"42"` and `{}` as `"[object Object]"` — and `@IsString` would
   * then dutifully accept both. Reading the raw value is what makes the type check real, so a
   * non-string reason is a `400` instead of a nonsense string in the audit trail (§13).
   */
  @Transform(({ obj }) => (obj as Record<string, unknown>).reason)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  /**
   * §9.3's `destination` — `ORIGINAL` (back through the gateway that took the money) or `WALLET`
   * (a `CUSTOMER_WALLET` ledger credit, no external call). `@IsEnum` rejects anything else, so
   * neither a typo nor an invented third destination reaches the command.
   *
   * Required, because §9.3 marks only `amount` optional. `RefundPaymentInput` still defaults to
   * `ORIGINAL` for in-process callers such as a compensating saga, which have no request body to
   * carry the choice; over HTTP the destination is always an explicit decision.
   */
  @IsEnum(RefundDestination)
  destination!: RefundDestination;
}
