import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AddCartItemCommand } from '../../application/commands/add-cart-item.command';
import { ClearCartCommand } from '../../application/commands/clear-cart.command';
import { RemoveCartItemCommand } from '../../application/commands/remove-cart-item.command';
import { UpdateCartItemQuantityCommand } from '../../application/commands/update-cart-item-quantity.command';
import { ValidateCartCommand } from '../../application/commands/validate-cart.command';
import { GetActiveCartQuery } from '../../application/queries/get-active-cart.query';
import { AddCartItemDto, UpdateCartItemQuantityDto } from '../dtos/cart.dto';

/**
 * Customer cart (`06-orders-spec.md` §9.1). Gated by `order:create:own` — §7.1's explicit
 * finding that cart mutation is a strict subset of "things a customer may do before placing an
 * order", so no redundant `cart:manage:own` permission is minted.
 *
 * Thin by design: cart ownership, lazy cart creation, the duplicate-product rule, quantity
 * validation and the fresh Catalog read all live in the commands/`CartPolicy` below this
 * boundary. Ownership is never taken from the request — every call is scoped to the access
 * token's subject, and a cart item belonging to someone else resolves to the same not-found the
 * commands already return (no existence leakage).
 *
 * `POST /cart/validate` (§9.1) refreshes prices/stock and returns the readiness report; its
 * price-drift semantics (§10's `PRICE_CHANGED` baseline) live in `ValidateCartCommand`, not here.
 */
@Controller('cart')
export class CartController {
  constructor(
    private readonly getActiveCart: GetActiveCartQuery,
    private readonly addItem: AddCartItemCommand,
    private readonly updateItemQuantity: UpdateCartItemQuantityCommand,
    private readonly removeItem: RemoveCartItemCommand,
    private readonly clearCart: ClearCartCommand,
    private readonly validateCart: ValidateCartCommand,
  ) {}

  @Get()
  @RequirePermissions('order:create:own')
  get(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.getActiveCart.execute({ customerUserId: user.userId });
  }

  @Post('items')
  @RequirePermissions('order:create:own')
  add(@CurrentUser() user: AuthenticatedPrincipal, @Body() dto: AddCartItemDto) {
    return this.addItem.execute({
      customerUserId: user.userId,
      catalogProductId: dto.catalogProductId,
      quantity: dto.quantity,
    });
  }

  @Patch('items/:id')
  @RequirePermissions('order:create:own')
  updateQuantity(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') cartItemId: string,
    @Body() dto: UpdateCartItemQuantityDto,
  ) {
    return this.updateItemQuantity.execute({
      customerUserId: user.userId,
      cartItemId,
      quantity: dto.quantity,
    });
  }

  /** §9.1 specifies `200`, not `204` — Nest's default for `@Delete` is already 200. */
  @Delete('items/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:create:own')
  async remove(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') cartItemId: string,
  ): Promise<void> {
    await this.removeItem.execute({ customerUserId: user.userId, cartItemId });
  }

  /** §9.1 `POST /cart/validate` → `200 { items: [{..., priceChanged, stillAvailable}],
   * readyForCheckout }`. Returns 200, not 201 — it reports on an existing cart, creating nothing. */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:create:own')
  validate(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.validateCart.execute({ customerUserId: user.userId });
  }

  /** Empties the cart; the cart row itself stays `ACTIVE` (§3.1). A customer with no cart yet is
   * a no-op, matching DELETE's natural idempotency — the command's own documented behaviour. */
  @Delete()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:create:own')
  async clear(@CurrentUser() user: AuthenticatedPrincipal): Promise<void> {
    await this.clearCart.execute({ customerUserId: user.userId });
  }
}
