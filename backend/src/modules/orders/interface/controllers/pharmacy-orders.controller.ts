import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { AcceptFulfillmentCommand } from '../../application/commands/accept-fulfillment.command';
import { DeclineFulfillmentCommand } from '../../application/commands/decline-fulfillment.command';
import { MarkReadyCommand } from '../../application/commands/mark-ready.command';
import { PrepareFulfillmentCommand } from '../../application/commands/prepare-fulfillment.command';
import { ListPharmacyOrdersQuery } from '../../application/queries/list-pharmacy-orders.query';
import { DeclineFulfillmentDto, ListPharmacyOrdersQueryDto } from '../dtos/fulfillment.dto';

/**
 * Pharmacy-side fulfillment actions (`06-orders-spec.md` §9.4, `order:fulfill:org`).
 *
 * `order:fulfill:org` establishes *that* the caller may fulfil orders; it does not say **which**
 * pharmacy's. That second question is answered below this boundary and is never taken from the
 * request — no route accepts a pharmacy or organization id. The mutating commands each call
 * `assertFulfillmentOrgScope`, which resolves the fulfillment's own `pharmacyId` to its owning
 * `Organization.id` before checking the caller's roles; the listing performs the same resolution
 * in reverse inside `ListPharmacyOrdersQuery`. A fulfillment belonging to another organization
 * resolves to the same not-found as a missing one (no existence leakage).
 *
 * Everything the actions actually do — the fulfillment/order state machines, the re-match on
 * decline (BR-ORD-14/BRULE-19), Rx dispensing on prepare (`IDispensingPort`), stock dispatch on
 * ready (`IInventoryPort.dispatch()`), and each command's `Serializable` transaction — stays in
 * the commands. This controller maps HTTP to them and nothing else.
 *
 * All four actions return `200` per §9.4, overriding `@Post`'s default 201: none creates a new
 * resource, they advance an existing fulfillment's state.
 */
@Controller('pharmacy/orders')
export class PharmacyOrdersController {
  constructor(
    private readonly listPharmacyOrders: ListPharmacyOrdersQuery,
    private readonly acceptFulfillment: AcceptFulfillmentCommand,
    private readonly declineFulfillment: DeclineFulfillmentCommand,
    private readonly prepareFulfillment: PrepareFulfillmentCommand,
    private readonly markReady: MarkReadyCommand,
  ) {}

  @Get()
  @RequirePermissions('order:fulfill:org')
  list(@CurrentUser() user: AuthenticatedPrincipal, @Query() query: ListPharmacyOrdersQueryDto) {
    return this.listPharmacyOrders.execute({
      actorUserId: user.userId,
      status: query.status,
      page: query.page ?? 1,
      size: query.size ?? 20,
    });
  }

  @Post(':fulfillmentId/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:fulfill:org')
  accept(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('fulfillmentId') fulfillmentId: string,
  ) {
    return this.acceptFulfillment.execute({ fulfillmentId, actorUserId: user.userId });
  }

  @Post(':fulfillmentId/decline')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:fulfill:org')
  decline(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('fulfillmentId') fulfillmentId: string,
    @Body() dto: DeclineFulfillmentDto,
  ) {
    return this.declineFulfillment.execute({
      fulfillmentId,
      actorUserId: user.userId,
      reason: dto.reason,
    });
  }

  @Post(':fulfillmentId/prepare')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:fulfill:org')
  prepare(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('fulfillmentId') fulfillmentId: string,
  ) {
    return this.prepareFulfillment.execute({ fulfillmentId, actorUserId: user.userId });
  }

  @Post(':fulfillmentId/ready')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('order:fulfill:org')
  ready(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('fulfillmentId') fulfillmentId: string,
  ) {
    return this.markReady.execute({ fulfillmentId, actorUserId: user.userId });
  }
}
