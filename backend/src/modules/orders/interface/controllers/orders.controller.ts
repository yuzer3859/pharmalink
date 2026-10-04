import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { CancelOrderCommand } from '../../application/commands/cancel-order.command';
import { GetOrderInvoiceQuery } from '../../application/queries/get-order-invoice.query';
import { GetOrderQuery } from '../../application/queries/get-order.query';
import { ListOrdersQuery } from '../../application/queries/list-orders.query';
import { CancelOrderDto, ListOrdersQueryDto } from '../dtos/order.dto';

/**
 * Customer order history and lifecycle (`06-orders-spec.md` §9.3, `order:read:own`).
 *
 * Every route is scoped to the access token's subject: `customerUserId` is passed from
 * `@CurrentUser()` into the query/command, never read from a path or query parameter. The
 * queries themselves treat "not yours" and "doesn't exist" identically (`ORDER_NOT_FOUND`), so
 * this controller adds no ownership check of its own that could diverge from theirs.
 *
 * Cancellation eligibility (`CancellationPolicy`, `CANCELLATION_NOT_ALLOWED`), reservation
 * release and the status-history write all belong to `CancelOrderCommand`.
 *
 * `order:read:own` gates the reads *and* the cancel: §7.1 mints no separate cancel permission,
 * and cancelling one's own order is not a distinct capability from managing it.
 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly listOrders: ListOrdersQuery,
    private readonly getOrder: GetOrderQuery,
    private readonly getInvoice: GetOrderInvoiceQuery,
    private readonly cancelOrder: CancelOrderCommand,
  ) {}

  @Get()
  @RequirePermissions('order:read:own')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: ListOrdersQueryDto) {
    return this.listOrders.execute({
      customerUserId: user.userId,
      status: query.status,
      page: query.page ?? 1,
      size: query.size ?? 20,
    });
  }

  @Get(':id')
  @RequirePermissions('order:read:own')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') orderId: string) {
    return this.getOrder.execute({ orderId, customerUserId: user.userId });
  }

  @Get(':id/invoice')
  @RequirePermissions('order:read:own')
  invoice(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') orderId: string) {
    return this.getInvoice.execute({ orderId, customerUserId: user.userId });
  }

  /** §9.3 specifies `200`, so the `@Post` default of 201 is overridden. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:read:own')
  cancel(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') orderId: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.cancelOrder.execute({
      orderId,
      customerUserId: user.userId,
      reason: dto.reason,
    });
  }
}
