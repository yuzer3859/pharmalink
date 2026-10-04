import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { QuoteDeliveryFeeQuery } from '../../application/queries/quote-delivery-fee.query';
import { DeliveryQuoteDto } from '../dtos/delivery-quote.dto';
import { DeliveryQuoteResponse, toDeliveryQuoteResponse } from '../dtos/delivery-quote.response';

/**
 * `GET /delivery/quote` (§9.2 — "`{ pickup, dropoff }` → delivery fee + distance + ETA (for
 * checkout pricing, FR-DEL-09)").
 *
 * ## Ids rather than the design's raw points
 *
 * The design sketches this route as taking a pickup and a dropoff. It takes an `addressId` and a
 * `branchId` instead, and the difference is the whole security property of the endpoint: raw
 * coordinates are a client-supplied input, and an input that moves a price is an input a client
 * will eventually move. With identifiers, the customer names *which* of their saved addresses and
 * *which* of the branches they were shown, and the platform resolves what those are — so a caller
 * cannot claim a destination two streets from the pharmacy for a delivery across the city.
 *
 * It also makes the ownership check possible at all. A coordinate belongs to nobody and can be
 * checked against nothing; an address id belongs to a customer, and Module 02 is asked whether it
 * belongs to *this* one.
 *
 * ## Authorization
 *
 * `order:read:own`, which `CUSTOMER` has held since Phase 0 — **no new permission key, in any of
 * the works in this module.** Asking what delivery will cost is part of reading your own
 * prospective order, and a `delivery:quote:own` key would be a second name for the same authority,
 * granted to the same role, requiring an RBAC migration before anybody could price a checkout.
 *
 * The permission decides who may ask; `IAddressPort` decides what they may ask *about*, by
 * filtering on the authenticated subject inside the query. A customer naming somebody else's
 * address gets `NOT_FOUND` rather than `FORBIDDEN`, so the route cannot be used to discover which
 * address ids exist or whose they are — the no-existence-leakage rule every other read in this
 * module follows.
 *
 * ## What this route cannot do
 *
 * It is a read. It creates no delivery job, touches no order, moves no money and writes nothing at
 * all — §10's requirements, which hold here by construction rather than by discipline, because
 * `QuoteDeliveryFeeQuery` has no repository and no unit of work to write with.
 *
 * It is also **not** a way to set a price. The amount it returns is an estimate; the charge is
 * recomputed inside `CheckoutCommand`'s transaction and frozen on `Order.deliveryFee`. Nothing a
 * client received here can be sent back to influence that — the checkout contract has no field for
 * a delivery fee, so there is no channel for a stale or edited quote to travel through.
 *
 * Errors are not caught. `NOT_FOUND` (404) for an address that is not the caller's or a branch that
 * does not exist, `VALIDATION_ERROR` (400) for a malformed id or an unexpected query parameter, and
 * `DEPENDENCY_UNAVAILABLE` (503) when the routing provider could not produce a distance — never a
 * fabricated fee (§10).
 */
@Controller('delivery')
export class DeliveryQuoteController {
  constructor(private readonly quotes: QuoteDeliveryFeeQuery) {}

  @Get('quote')
  @RequirePermissions('order:read:own')
  async quote(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: DeliveryQuoteDto,
  ): Promise<DeliveryQuoteResponse> {
    return toDeliveryQuoteResponse(
      await this.quotes.quote({
        // From the token. The DTO has no field through which a customer id could arrive.
        customerUserId: user.userId,
        addressId: query.addressId,
        branchId: query.branchId,
      }),
    );
  }
}
