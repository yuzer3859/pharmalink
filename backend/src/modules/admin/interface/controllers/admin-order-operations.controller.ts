import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetOrderOperationsQuery, ListOrderOperationsQuery } from '../../application/queries/order-operations.queries';
import { ListOrderOperationsQueryDto } from '../dtos/order-operations.dto';
import {
  OrderOperationsDetailResponse,
  OrderOperationsListResponse,
  toOrderOperationsDetailResponse,
  toOrderOperationsListResponse,
} from '../dtos/order-operations.response';

/**
 * Order operations visibility (module-16 Work 35) — read-only:
 *
 *     GET /admin/operations/orders            ?status &isCod &orderNumber &createdFrom &createdTo &hasDeliveryJobReference
 *                                             &hasUnreferencedFulfillment &page &size
 *     GET /admin/operations/orders/:orderId   one order, its fulfillments, its payment's status
 *
 * `order:read:any` — added by this work; ADMIN only, SUPER_ADMIN by wildcard. It grants no order,
 * payment or delivery action. No customer, beneficiary or address data is returned. Not audited.
 */
@Controller('admin/operations/orders')
@RequirePermissions('order:read:any')
export class AdminOrderOperationsController {
  constructor(
    private readonly list: ListOrderOperationsQuery,
    private readonly getOne: GetOrderOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListOrderOperationsQueryDto): Promise<OrderOperationsListResponse> {
    return toOrderOperationsListResponse(
      await this.list.execute({
        status: q.status,
        isCod: q.isCod === undefined ? undefined : q.isCod === 'true',
        orderNumber: q.orderNumber,
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        hasDeliveryJobReference: q.hasDeliveryJobReference === undefined ? undefined : q.hasDeliveryJobReference === 'true',
        hasUnreferencedFulfillment: q.hasUnreferencedFulfillment === undefined ? undefined : q.hasUnreferencedFulfillment === 'true',
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':orderId')
  async detail(@Param('orderId', new ParseUUIDPipe()) orderId: string): Promise<OrderOperationsDetailResponse> {
    return toOrderOperationsDetailResponse(await this.getOne.execute(orderId));
  }
}
