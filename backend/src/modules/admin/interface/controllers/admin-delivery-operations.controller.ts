import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetDeliveryOperationsQuery, ListDeliveryOperationsQuery } from '../../application/queries/delivery-operations.queries';
import { ListDeliveryOperationsQueryDto } from '../dtos/delivery-operations.dto';
import {
  DeliveryOperationsDetailResponse,
  DeliveryOperationsListResponse,
  toDeliveryOperationsDetailResponse,
  toDeliveryOperationsListResponse,
} from '../dtos/delivery-operations.response';

/**
 * Delivery operations visibility (module-16 Work 36) — read-only:
 *
 *     GET /admin/operations/deliveries                  ?status &orderId &isCod &createdFrom &createdTo &page &size
 *     GET /admin/operations/deliveries/:deliveryJobId   one job, its timeline, its COD collection state
 *
 * `delivery:read:any` — added by this work; ADMIN only, SUPER_ADMIN by wildcard. It grants no
 * delivery action. No address, GPS position, proof of delivery or driver personal data is returned.
 * Not audited.
 */
@Controller('admin/operations/deliveries')
@RequirePermissions('delivery:read:any')
export class AdminDeliveryOperationsController {
  constructor(
    private readonly list: ListDeliveryOperationsQuery,
    private readonly getOne: GetDeliveryOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListDeliveryOperationsQueryDto): Promise<DeliveryOperationsListResponse> {
    return toDeliveryOperationsListResponse(
      await this.list.execute({
        status: q.status,
        orderId: q.orderId,
        isCod: q.isCod === undefined ? undefined : q.isCod === 'true',
        createdFrom: q.createdFrom ? new Date(q.createdFrom) : undefined,
        createdTo: q.createdTo ? new Date(q.createdTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':deliveryJobId')
  async detail(
    @Param('deliveryJobId', new ParseUUIDPipe()) deliveryJobId: string,
  ): Promise<DeliveryOperationsDetailResponse> {
    return toDeliveryOperationsDetailResponse(await this.getOne.execute(deliveryJobId));
  }
}
