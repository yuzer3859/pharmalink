import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetFulfillmentOperationsQuery, ListFulfillmentOperationsQuery } from '../../application/queries/fulfillment-operations.queries';
import { ListFulfillmentOperationsQueryDto } from '../dtos/fulfillment-operations.dto';
import {
  FulfillmentOperationsListResponse,
  FulfillmentOperationsResponse,
  toFulfillmentOperationsListResponse,
  toFulfillmentOperationsResponse,
} from '../dtos/fulfillment-operations.response';

/**
 * Fulfillment operations visibility (module-16 Work 46) — read-only:
 *
 *     GET /admin/operations/fulfillments                  ?status &orderId &pharmacyId &branchId &hasDeliveryJobReference
 *                                                         &createdFrom &createdTo &readyFrom &readyTo &page &size
 *     GET /admin/operations/fulfillments/:fulfillmentId   one fulfillment, its order id and recorded delivery-job id
 *
 * `order:read:any`, as Work 35, whose order detail already shows these fulfillment fields to the same
 * holders. The id is UUID-validated, so no reserved segment can be read as one. No delivery status, no
 * call to Module 08, no reference repair. Not audited.
 */
@Controller('admin/operations/fulfillments')
@RequirePermissions('order:read:any')
export class AdminFulfillmentOperationsController {
  constructor(
    private readonly list: ListFulfillmentOperationsQuery,
    private readonly getOne: GetFulfillmentOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListFulfillmentOperationsQueryDto): Promise<FulfillmentOperationsListResponse> {
    const date = (v?: string) => (v ? new Date(v) : undefined);
    return toFulfillmentOperationsListResponse(
      await this.list.execute({
        status: q.status,
        orderId: q.orderId,
        pharmacyId: q.pharmacyId,
        branchId: q.branchId,
        hasDeliveryJobReference: q.hasDeliveryJobReference === undefined ? undefined : q.hasDeliveryJobReference === 'true',
        createdFrom: date(q.createdFrom),
        createdTo: date(q.createdTo),
        readyFrom: date(q.readyFrom),
        readyTo: date(q.readyTo),
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':fulfillmentId')
  async detail(@Param('fulfillmentId', new ParseUUIDPipe()) fulfillmentId: string): Promise<FulfillmentOperationsResponse> {
    return toFulfillmentOperationsResponse(await this.getOne.execute(fulfillmentId));
  }
}
