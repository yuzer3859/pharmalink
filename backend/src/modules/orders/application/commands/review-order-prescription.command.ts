import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IPrescriptionReviewRoutingPort,
  PRESCRIPTION_REVIEW_ROUTING_PORT,
} from '../../../prescription-matching/application/ports/inbound/prescription-review-routing.port';
import { OrderStatus } from '../../domain/enums';
import { OrdersErrors } from '../../domain/errors';
import { orderPaidEvent } from '../../domain/events';
import { FULFILLMENT_REPOSITORY, IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, ORDER_REPOSITORY, OrderSnapshot } from '../../domain/repositories/order.repository';
import { OrderStatusPolicy } from '../../domain/services/order-status-policy';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { OrderCancellationWorkflow } from '../services/order-cancellation.workflow';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';
import { runWithOrderRetry } from '../support/order-retry';

export interface ApproveOrderPrescriptionInput {
  fulfillmentId: string;
  actorUserId: string;
  legibilityOk: boolean;
  validityOk: boolean;
}

export interface RejectOrderPrescriptionInput {
  fulfillmentId: string;
  actorUserId: string;
  reason: string;
}

/** The cancellation reason a rejected prescription leaves on the order, ahead of the pharmacist's words. */
export const PRESCRIPTION_REJECTED_REASON = 'prescription-rejected';

/**
 * Work 129 (owner decision 2026-11-16): the pharmacist reviews the prescription on the order
 * itself. `POST /pharmacy/orders/:fulfillmentId/prescription/approve|reject`.
 *
 * Who may decide: the caller must be staff of the pharmacy filling the order (the same scope check
 * every fulfilment action makes), and Module 05's own approve and reject commands then require the
 * PHARMACIST role at that pharmacy's organisation, the one the prescription was sent to.
 *
 * - **Approve:** the prescription is approved for exactly what the order asks (one line per
 *   prescription product, the ordered quantity), each Rx order line is pointed at its approved
 *   line (dispensed at prepare, as before), and the review is recorded. A cash-on-delivery order
 *   is then paid (`PENDING_PAYMENT -> PAID`) and goes to the pharmacy's new orders; a prepaid one
 *   waits for the customer to pay (`POST /orders/:id/pay`).
 * - **Reject:** the prescription is rejected with the pharmacist's reason, and the order is
 *   cancelled through the customer cancellation workflow: stock released, coupon reversed. The
 *   order's cancel reason carries the pharmacist's words for the customer.
 *
 * Both are safe to retry: Module 05 answers an already-made decision with the same outcome.
 */
@Injectable()
export class ReviewOrderPrescriptionCommand {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    @Inject(PRESCRIPTION_REVIEW_ROUTING_PORT) private readonly rxReview: IPrescriptionReviewRoutingPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly cancellation: OrderCancellationWorkflow,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async approve(input: ApproveOrderPrescriptionInput): Promise<OrderSnapshot> {
    if (!input.legibilityOk || !input.validityOk) {
      throw OrdersErrors.validation('Confirm the prescription is legible and valid before approving it.');
    }
    const order = await this.pendingReview(input.fulfillmentId, input.actorUserId);
    const lines = await this.orders.findLinesByOrderId(order.id);
    const rxLines = lines.filter((line) => line.requiresRx);

    const approved = await this.rxReview.approveForOrder({
      prescriptionId: order.prescriptionId as string,
      reviewerUserId: input.actorUserId,
      items: rxLines.map((line) => ({ catalogProductId: line.catalogProductId, quantity: line.quantity })),
      legibilityOk: input.legibilityOk,
      validityOk: input.validityOk,
    });
    const lineIdByProduct = new Map(approved.map((a) => [a.catalogProductId, a.prescriptionLineId]));

    await runWithOrderRetry(this.uow, async (tx) => {
      const fresh = await this.orders.findById(order.id, tx);
      if (!fresh) throw OrdersErrors.orderNotFound();
      if (fresh.rxReviewStatus !== 'PENDING') return;

      await this.orders.setLinePrescriptionLines(
        rxLines.map((line) => ({ orderLineId: line.id, prescriptionLineId: lineIdByProduct.get(line.catalogProductId) as string })),
        tx,
      );
      const reviewedAt = new Date();
      // A cash-on-delivery order is paid on approval, as checkout pays one with no prescription.
      const paidNow = fresh.isCod && fresh.status === OrderStatus.PENDING_PAYMENT;
      if (paidNow) OrderStatusPolicy.assertValidTransition(fresh.status, OrderStatus.PAID);
      await this.orders.updateStatus(
        fresh.id,
        { status: paidNow ? OrderStatus.PAID : fresh.status, rxReviewStatus: 'APPROVED', rxReviewedAt: reviewedAt },
        {
          fromStatus: fresh.status,
          toStatus: paidNow ? OrderStatus.PAID : fresh.status,
          event: paidNow ? 'PRESCRIPTION_APPROVED_COD_CONFIRMED' : 'PRESCRIPTION_APPROVED',
          actorUserId: input.actorUserId,
          actorRole: 'PHARMACIST',
        },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'ORDER_PRESCRIPTION_APPROVED',
          resourceType: 'Order',
          resourceId: fresh.id,
          context: { prescriptionId: fresh.prescriptionId, fulfillmentId: input.fulfillmentId },
        },
        tx,
      );
      if (paidNow) {
        await this.outbox.write(orderPaidEvent({ orderId: fresh.id, paymentId: null }), tx as never);
      }
    });
    return (await this.orders.findById(order.id)) as OrderSnapshot;
  }

  async reject(input: RejectOrderPrescriptionInput): Promise<OrderSnapshot> {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw OrdersErrors.validation('Give the customer a reason of 3 to 500 characters.');
    }
    // A rejection whose cancellation did not finish (a crash in between) can be sent again.
    const order = await this.pendingReview(input.fulfillmentId, input.actorUserId, true);

    await this.rxReview.rejectForOrder({ prescriptionId: order.prescriptionId as string, reviewerUserId: input.actorUserId, reason });

    await runWithOrderRetry(this.uow, async (tx) => {
      const fresh = await this.orders.findById(order.id, tx);
      if (!fresh) throw OrdersErrors.orderNotFound();
      if (fresh.rxReviewStatus !== 'PENDING') return;
      await this.orders.updateStatus(
        fresh.id,
        { status: fresh.status, rxReviewStatus: 'REJECTED', rxReviewedAt: new Date() },
        { fromStatus: fresh.status, toStatus: fresh.status, event: 'PRESCRIPTION_REJECTED', actorUserId: input.actorUserId, actorRole: 'PHARMACIST', reason },
        tx,
      );
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'ORDER_PRESCRIPTION_REJECTED',
          resourceType: 'Order',
          resourceId: fresh.id,
          context: { prescriptionId: fresh.prescriptionId, fulfillmentId: input.fulfillmentId, reason },
        },
        tx,
      );
    });

    // The stock goes back and the order is cancelled the way a customer cancellation is.
    await this.cancellation.start({
      orderId: order.id,
      customerUserId: order.customerUserId,
      reason: `${PRESCRIPTION_REJECTED_REASON}: ${reason}`,
    });
    return (await this.orders.findById(order.id)) as OrderSnapshot;
  }

  /** The order behind the fulfilment, in the caller's pharmacy, with its prescription still to review. */
  private async pendingReview(fulfillmentId: string, actorUserId: string, rejectedToo = false): Promise<OrderSnapshot> {
    const fulfillment = await this.fulfillments.findById(fulfillmentId);
    if (!fulfillment) throw OrdersErrors.notFound('Fulfillment not found.');
    await assertFulfillmentOrgScope(this.identity, this.pharmacies, actorUserId, fulfillment.pharmacyId);
    const order = await this.orders.findById(fulfillment.orderId);
    if (!order) throw OrdersErrors.orderNotFound();
    const reviewable = order.rxReviewStatus === 'PENDING' || (rejectedToo && order.rxReviewStatus === 'REJECTED');
    if (!order.prescriptionId || !reviewable || order.status !== OrderStatus.PENDING_PAYMENT) {
      throw OrdersErrors.validation('This order has no prescription waiting for review.');
    }
    return order;
  }
}
