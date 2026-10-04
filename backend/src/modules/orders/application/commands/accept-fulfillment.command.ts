import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { OrdersErrors } from '../../domain/errors';
import { FulfillmentStatus, OrderStatus } from '../../domain/enums';
import { orderAcceptedEvent } from '../../domain/events';
import {
  FulfillmentSnapshot,
  FULFILLMENT_REPOSITORY,
  IFulfillmentRepository,
} from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { FulfillmentStatusPolicy } from '../../domain/services/fulfillment-status-policy';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';
import { runWithOrderRetry } from '../support/order-retry';

export interface AcceptFulfillmentInput {
  fulfillmentId: string;
  actorUserId: string;
}

/**
 * `POST /pharmacy/orders/:fulfillmentId/accept` (module-06 `06-orders-spec.md` §9.4, §3.4, §3.6,
 * BR-ORD-10). Org-scoped to the fulfillment's own `pharmacyId` (Step 6, `assertFulfillmentOrgScope`)
 * — a missing fulfillment and one owned by another pharmacy both resolve to the same generic
 * not-found (no existence leakage across organizations).
 *
 * Slice 1 has exactly one `Fulfillment` per `Order` (§3.6), so accepting it always cascades
 * `Order.status: PAID -> ACCEPTED` in the same step (§3.4's transition table) — both state
 * machines (`FulfillmentStatusPolicy`/`OrderStatusPolicy`) are asserted independently, never
 * collapsed into one, per their own respective doc comments.
 *
 * Single `Serializable` transaction (§11): re-read both fresh inside the transaction, re-validate
 * both transitions, persist `Fulfillment.status -> ACCEPTED` + `Order.status -> ACCEPTED` (+
 * `OrderStatusHistory` row), audit entry, outbox `OrderAccepted` (§8).
 */
@Injectable()
export class AcceptFulfillmentCommand {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: AcceptFulfillmentInput): Promise<FulfillmentSnapshot> {
    const fulfillment = await this.fulfillments.findById(input.fulfillmentId);
    if (!fulfillment) {
      throw OrdersErrors.notFound('Fulfillment not found.');
    }
    await assertFulfillmentOrgScope(
      this.identity,
      this.pharmacies,
      input.actorUserId,
      fulfillment.pharmacyId,
    );

    const order = await this.orders.findById(fulfillment.orderId);
    if (!order) {
      throw OrdersErrors.orderNotFound();
    }

    FulfillmentStatusPolicy.assertValidTransition(fulfillment.status, FulfillmentStatus.ACCEPTED);
    OrderStatusPolicy.assertValidTransition(order.status, OrderStatus.ACCEPTED);

    return runWithOrderRetry(this.uow, async (tx) => {
      const freshFulfillment = await this.fulfillments.findById(fulfillment.id, tx);
      const freshOrder = await this.orders.findById(order.id, tx);
      if (!freshFulfillment || !freshOrder) {
        throw OrdersErrors.notFound('Fulfillment not found.');
      }
      FulfillmentStatusPolicy.assertValidTransition(
        freshFulfillment.status,
        FulfillmentStatus.ACCEPTED,
      );
      OrderStatusPolicy.assertValidTransition(freshOrder.status, OrderStatus.ACCEPTED);

      await this.fulfillments.updateStatus(
        freshFulfillment.id,
        { status: FulfillmentStatus.ACCEPTED, acceptedAt: new Date() },
        tx,
      );
      await this.orders.updateStatus(
        freshOrder.id,
        { status: OrderStatus.ACCEPTED },
        {
          fromStatus: freshOrder.status,
          toStatus: OrderStatus.ACCEPTED,
          event: 'ORDER_ACCEPTED',
          actorUserId: input.actorUserId,
          actorRole: 'PHARMACY',
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'ORDER_ACCEPTED',
          resourceType: 'Order',
          resourceId: freshOrder.id,
          context: { fulfillmentId: freshFulfillment.id, pharmacyId: freshFulfillment.pharmacyId },
        },
        tx,
      );

      await this.outbox.write(
        orderAcceptedEvent({
          orderId: freshOrder.id,
          fulfillmentId: freshFulfillment.id,
          pharmacyId: freshFulfillment.pharmacyId,
        }),
        tx as never,
      );

      return (await this.fulfillments.findById(freshFulfillment.id, tx)) as FulfillmentSnapshot;
    });
  }
}
