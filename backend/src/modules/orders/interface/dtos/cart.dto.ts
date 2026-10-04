import { IsInt, IsUUID, Min } from 'class-validator';

/**
 * `POST /cart/items` (`06-orders-spec.md` §9.1). `beneficiaryId` is omitted deliberately (§0.2 —
 * `Beneficiary` is unimplemented in Module 02), matching `AddCartItemInput`, which has no such
 * field. `customerUserId` is never accepted from the client; it comes from the access token.
 *
 * Only the shape is validated here. Whether the product exists, is `ACTIVE`, is already in the
 * cart, or is priced belongs to `AddCartItemCommand`/`CartPolicy` and is not duplicated.
 */
export class AddCartItemDto {
  @IsUUID()
  catalogProductId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/**
 * `PATCH /cart/items/:id` (§9.1). The domain `Quantity` value object is the authority on the
 * quantity rule; `@Min(1)` here only rejects obvious garbage at the boundary so a malformed
 * request never reaches the application layer.
 */
export class UpdateCartItemQuantityDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}
