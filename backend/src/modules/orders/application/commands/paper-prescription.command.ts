import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { DELIVERY_PAPER_READ_PORT, IDeliveryPaperReadPort } from '../../../delivery/application/ports/inbound/delivery-paper-read.port';
import { FulfillmentStatus } from '../../domain/enums';
import { OrdersErrors } from '../../domain/errors';
import { FULFILLMENT_REPOSITORY, FulfillmentSnapshot, IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderPaperRepository, ORDER_PAPER_REPOSITORY, OrderPaperState } from '../../domain/repositories/order-paper.repository';
import { IOrderRepository, ORDER_REPOSITORY, OrderSnapshot } from '../../domain/repositories/order.repository';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IPharmacyPort, PHARMACY_PORT } from '../ports/outbound/pharmacy.port';
import { OrderCancellationWorkflow } from '../services/order-cancellation.workflow';
import { assertFulfillmentOrgScope } from '../support/assert-fulfillment-org-scope';

/** The cancellation reason a rejected paper prescription leaves on the order, ahead of the pharmacist's words. */
export const PAPER_RX_REJECTED_REASON = 'paper-prescription-rejected';

const PHARMACIST_ROLE_KEY = 'PHARMACIST';
const DRIVER_AT_PHARMACY = 'ARRIVED_PICKUP';

/**
 * Work 136 (owner decision 2026-11-17): the pharmacist checks the original paper prescription the
 * driver brought from the customer — `POST /pharmacy/orders/:fulfillmentId/paper-prescription/
 * verify|reject` — before the medicine is prepared.
 *
 * Only a PHARMACIST of the filling pharmacy, only on an order that needs the paper, only while the
 * order is accepted and not yet prepared (nothing dispensed, no stock dispatched, no payment
 * captured), and only once the driver has collected the paper and is at the pharmacy with it.
 *
 * - **Verify**: the pharmacist keeps the paper (where the law asks it to be retained) and the
 *   pharmacy may prepare the order; the driver then takes the medicine to the customer.
 * - **Reject**: the paper does not match. The order is cancelled the way a customer cancellation is
 *   — stock released, an authorised prepayment voided — and its delivery job is cancelled with it.
 *   No medicine is handed out; the driver returns the paper to the customer.
 */
@Injectable()
export class PaperPrescriptionCommand {
  constructor(
    @Inject(FULFILLMENT_REPOSITORY) private readonly fulfillments: IFulfillmentRepository,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(ORDER_PAPER_REPOSITORY) private readonly paper: IOrderPaperRepository,
    @Inject(DELIVERY_PAPER_READ_PORT) private readonly delivery: IDeliveryPaperReadPort,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(PHARMACY_PORT) private readonly pharmacies: IPharmacyPort,
    private readonly cancellation: OrderCancellationWorkflow,
    private readonly audit: AuditService,
  ) {}

  async verify(input: { fulfillmentId: string; actorUserId: string }, now = new Date()): Promise<OrderPaperState> {
    const { order, fulfillment } = await this.checkable(input.fulfillmentId, input.actorUserId);
    if (await this.paper.markVerified(order.id, input.actorUserId, now)) {
      await this.audit.record({
        actorUserId: input.actorUserId,
        action: 'ORDER_PAPER_RX_VERIFIED',
        resourceType: 'Order',
        resourceId: order.id,
        context: { fulfillmentId: fulfillment.id },
      });
    }
    return (await this.paper.findByOrderId(order.id)) as OrderPaperState;
  }

  async reject(input: { fulfillmentId: string; actorUserId: string; reason: string }): Promise<OrderSnapshot> {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) throw OrdersErrors.validation('Give the customer a reason of 3 to 500 characters.');
    const { order, fulfillment } = await this.checkable(input.fulfillmentId, input.actorUserId);
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'ORDER_PAPER_RX_REJECTED',
      resourceType: 'Order',
      resourceId: order.id,
      context: { fulfillmentId: fulfillment.id, reason },
    });
    await this.cancellation.start({ orderId: order.id, customerUserId: order.customerUserId, reason: `${PAPER_RX_REJECTED_REASON}: ${reason}` });
    return (await this.orders.findById(order.id)) as OrderSnapshot;
  }

  private async checkable(fulfillmentId: string, actorUserId: string): Promise<{ order: OrderSnapshot; fulfillment: FulfillmentSnapshot }> {
    const fulfillment = await this.fulfillments.findById(fulfillmentId);
    if (!fulfillment) throw OrdersErrors.notFound('Fulfillment not found.');
    await assertFulfillmentOrgScope(this.identity, this.pharmacies, actorUserId, fulfillment.pharmacyId);
    const organizationId = await this.pharmacies.getOrganizationId(fulfillment.pharmacyId);
    if (!organizationId || !(await this.identity.hasRoleAtOrganization(actorUserId, organizationId, PHARMACIST_ROLE_KEY))) {
      throw OrdersErrors.validation('Only a pharmacist of this pharmacy can check the paper prescription.');
    }
    const [order, paper] = await Promise.all([this.orders.findById(fulfillment.orderId), this.paper.findByOrderId(fulfillment.orderId)]);
    if (!order || !paper) throw OrdersErrors.orderNotFound();
    if (!paper.paperRxRequired) throw OrdersErrors.validation('This order does not need the original paper prescription.');
    if (paper.paperRxVerifiedAt) throw OrdersErrors.validation('The paper prescription was already checked.');
    if (fulfillment.status !== FulfillmentStatus.ACCEPTED) {
      throw OrdersErrors.validation('The paper prescription is checked after accepting the order and before preparing it.');
    }
    const job = await this.delivery.findByFulfillmentId(fulfillment.id);
    if (!job?.paperCollectedAt || job.status !== DRIVER_AT_PHARMACY) {
      throw OrdersErrors.validation('The driver has not brought the paper prescription to the pharmacy yet.');
    }
    return { order, fulfillment };
  }
}
