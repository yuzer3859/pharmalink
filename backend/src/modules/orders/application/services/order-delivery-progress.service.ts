import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { FulfillmentStatus, OrderStatus } from '../../domain/enums';
import { FULFILLMENT_REPOSITORY, IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithOrderRetry } from '../support/order-retry';

export type DeliveryMilestone = 'PICKED_UP' | 'DELIVERED';
export type ProgressOutcome = 'ADVANCED' | 'ALREADY' | 'IGNORED';

/**
 * Work 103 (Phase 1 audit G14): Module 08's delivery advances the order (module-08 §2: "It does not
 * own order state (Module 6), it emits events that advance the order"). Before this, nothing
 * consumed those events and an order stayed `READY` after its delivery.
 *
 *  - `delivery.order.picked_up` → fulfilment and order `READY -> DISPATCHED`;
 *  - `delivery.order.delivered` → `DISPATCHED -> DELIVERED` (through `DISPATCHED` first if the
 *    pickup event was missed).
 *
 * One Serializable transaction per milestone: status, history row (`actorRole: SYSTEM`) and
 * audit. Idempotent: an order already at or past the milestone is left alone, so a redelivered
 * or out-of-order event changes nothing.
 */
@Injectable()
export class OrderDeliveryProgressService {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async apply(input: { orderId: string; fulfillmentId: string; jobId: string; milestone: DeliveryMilestone }): Promise<ProgressOutcome> {
    return runWithOrderRetry(this.uow, async (tx) => {
      const order = await this.orders.findById(input.orderId, tx);
      const fulfillment = await this.fulfillments.findById(input.fulfillmentId, tx);
      if (!order || !fulfillment || fulfillment.orderId !== order.id) return 'IGNORED';

      const steps: OrderStatus[] =
        input.milestone === 'PICKED_UP' ? [OrderStatus.DISPATCHED] : [OrderStatus.DISPATCHED, OrderStatus.DELIVERED];
      let status = order.status as OrderStatus;
      let advanced = false;
      for (const target of steps) {
        if (status === target || !OrderStatusPolicy.isLegalTransition(status, target)) continue;
        const fulfillmentTarget = target === OrderStatus.DISPATCHED ? FulfillmentStatus.DISPATCHED : FulfillmentStatus.DELIVERED;
        const freshFulfillment = await this.fulfillments.findById(fulfillment.id, tx);
        if (freshFulfillment && FulfillmentStatusPolicy.isLegalTransition(freshFulfillment.status as FulfillmentStatus, fulfillmentTarget)) {
          await this.fulfillments.updateStatus(fulfillment.id, { status: fulfillmentTarget }, tx);
        }
        await this.orders.updateStatus(
          order.id,
          { status: target },
          {
            fromStatus: status,
            toStatus: target,
            event: target === OrderStatus.DISPATCHED ? 'DELIVERY_PICKED_UP' : 'DELIVERY_DELIVERED',
            actorUserId: null,
            actorRole: 'SYSTEM',
          },
          tx,
        );
        await this.audit.record(
          {
            actorUserId: null,
            action: target === OrderStatus.DISPATCHED ? 'ORDER_DISPATCHED' : 'ORDER_DELIVERED',
            resourceType: 'Order',
            resourceId: order.id,
            context: { jobId: input.jobId, fulfillmentId: fulfillment.id },
          },
          tx,
        );
        status = target;
        advanced = true;
      }
      return advanced ? 'ADVANCED' : 'ALREADY';
    });
  }
}
