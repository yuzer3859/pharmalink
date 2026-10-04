import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `POST /checkout` request body (`06-orders-spec.md` §9.2/§287, Slice 1 COD-only).
 *
 * **`idempotencyKey` is a body field, not an `Idempotency-Key` header** — §13.5 decides this
 * explicitly ("DTO-body `idempotencyKey` field, not an HTTP header + interceptor … the parent
 * doc's `+ Idempotency-Key` header phrasing has no precedent in this codebase and would introduce
 * a new cross-cutting interceptor pattern — **not adopted**"), `CheckoutInput.idempotencyKey`
 * carries the same instruction, and both Module 04 (`ReserveStockDto.idempotencyKey`) and Module
 * 05 (`DispenseMedicineInput.idempotencyKey`) already use a body field. Reading a header here
 * would be a second idempotency mechanism, not the existing one.
 *
 * Fields the parent design lists but Slice 1's `CheckoutCommand` does not accept are deliberately
 * absent rather than accepted-and-ignored:
 * - `beneficiaryId` — `Beneficiary` is unimplemented in Module 02 (§0.2/§13.4); the saga writes
 *   `beneficiarySnapshot: null`. Accepting it would imply beneficiary-scoped checkout works.
 * - `paymentMethod` — Slice 1 is COD-only; the saga hardcodes `isCod: true` and there is no
 *   gateway (Module 07 is out of scope). A `paymentMethod` field with exactly one legal value
 *   would be inert HTTP surface.
 * - `chosenPharmacyId`/`useWallet` — no corresponding `CheckoutInput` field. `chosenPharmacyId`
 *   stays absent on purpose and not merely for lack of plumbing: Module 05's matching owns the
 *   dispensing-pharmacy decision (ADR-020 clause 3), and a client-named pharmacy would be a second
 *   selection path around it.
 *
 * `couponCode` **is** now accepted — the coupon integration (ADR-019/020/021) added it.
 */
/**
 * `POST /checkout/quote` request body (§9.2 — `{ addressId, deliverySlot? }`). No
 * `idempotencyKey`: a quote creates nothing, so there is no write to make idempotent. No
 * customer field — identity comes from the access token.
 */
export class CheckoutQuoteDto {
  @IsUUID()
  addressId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deliverySlot?: string;
}

export class CheckoutDto {
  /** Delivery address; ownership is verified by `IAddressPort` below the controller, not here. */
  @IsUUID()
  addressId!: string;

  /** Free-form slot label (§3.3) — the saga stores it verbatim on `Order.deliverySlot`; no
   * scheduled-delivery behaviour exists in Slice 1. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  deliverySlot?: string;

  /**
   * Client-supplied replay key (§4/§13.5). Required — the saga's first step reads it, and
   * `Order.idempotencyKey` is a non-nullable `@unique` column, so there is no "no key" path.
   * Length-bounded only; uniqueness/conflict semantics belong to the application layer.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey!: string;

  /**
   * Optional promotion code (ADR-021 — **at most one**; there is no array here and stacking is
   * refused, by this shape and again in Module 07's redemption).
   *
   * Validated to `CouponCode`'s own canonical alphabet rather than accepted as free text, so a
   * malformed code is a `400` at the edge instead of travelling through matching and reservation
   * only to be refused at step 5. Module 07 still normalizes and re-validates it — this is the
   * outer of two checks, never the only one. The transform mirrors `CouponCode.normalize` (trim +
   * upper-case) so `save10` and `SAVE10` are the same coupon here as they are there.
   *
   * Only the code crosses the wire. The discount amount, the eligible subtotal and the pharmacy
   * the coupon is scored against are all server-determined: a client that could send a discount
   * could choose its own.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[A-Z0-9_-]+$/, {
    message: 'couponCode may contain only letters, digits, hyphens and underscores.',
  })
  couponCode?: string;
}
