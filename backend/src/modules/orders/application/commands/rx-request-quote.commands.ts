import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { DELIVERY_PRICING_PORT, IDeliveryPricingPort } from '../../../delivery/application/ports/inbound/delivery-pricing.port';
import { OrdersErrors } from '../../domain/errors';
import { IOrderRepository, ORDER_REPOSITORY } from '../../domain/repositories/order.repository';
import { rxRequestEvents } from '../../domain/rx-request-events';
import { IRxRequestRepository, RX_REQUEST_REPOSITORY, RxQuote, RxQuoteLine, RxRequestSnapshot } from '../../domain/repositories/rx-request.repository';
import { PricingCalculator } from '../../domain/services/pricing-calculator';
import { RxClassificationPolicy } from '../../domain/services/rx-classification-policy';
import { RX_REQUEST_CLOSED_REASON, RxRequestPolicy } from '../../domain/services/rx-request-policy';
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';
import { IRxRequestPharmaciesPort, RX_REQUEST_PHARMACIES_PORT } from '../ports/outbound/rx-request-pharmacies.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithOrderRetry } from '../support/order-retry';
import { CheckoutCommand, CheckoutResult, PrepaidPaymentInput } from './checkout.command';
import { PayOrderCommand } from './pay-order.command';
import { ReviewOrderPrescriptionCommand } from './review-order-prescription.command';
import { RxRequestErrors } from './rx-request.commands';

export interface QuoteRxRequestInput {
  requestId: string;
  actorUserId: string;
  lines: Array<{ catalogProductId: string; quantity: number }>;
  /** The date on the prescription as the pharmacist reads it. */
  prescriptionIssueDate: Date;
  /** `undefined` takes the default: required when any quoted medicine is a controlled substance. */
  paperRequired?: boolean;
  legibilityOk: boolean;
  validityOk: boolean;
  note?: string | null;
}

/** One order per request: checkout is keyed by the request, so any retry finishes the same order. */
export function rxRequestOrderKey(requestId: string): string {
  return `rx-request-${requestId}`;
}

export interface ConfirmRxRequestInput {
  requestId: string;
  customerUserId: string;
  /** Absent: cash on delivery. */
  payment?: PrepaidPaymentInput;
}

/** A controlled substance the platform never sells. */
const PROHIBITED_SCHEDULE = 'PROHIBITED';
const NO_SCHEDULE = 'NONE';

/**
 * Work 135 (owner decision 2026-11-17): the pharmacy's quote, and the customer's answer.
 *
 * - **Quote**: the pharmacist of the pharmacy holding the request lists what it will give (from its
 *   own stock at the nearest branch), confirms the prescription's date — checked against the
 *   strictest limit of the quoted medicines' controlled schedules (`prescriptions.maxAgeDays`,
 *   `prescriptions.maxAgeDaysBySchedule`) — attests it is legible and valid, and says whether the
 *   original paper is needed. By default it is whenever a quoted medicine is a controlled
 *   substance; the pharmacist decides. Lines are priced exactly as checkout prices an order
 *   (catalogue price, delivery fee for that branch, platform fee), so the customer agrees to the
 *   total they will pay. The customer has `rxRequests.quoteResponseMinutes` to answer.
 * - **Confirm**: the quote becomes an order through checkout itself — the quoted lines at that
 *   pharmacy only, the prescription attached — and the prescription is approved on the order as
 *   the quoting pharmacist (their quote was the review). Cash on delivery is then paid; a prepaid
 *   order is paid in the same call. A retry with the same key finishes the same order.
 * - **Decline**: the customer turns the quote down; the request ends and the pharmacy is told.
 */
@Injectable()
export class RxRequestQuoteCommands {
  constructor(
    @Inject(RX_REQUEST_REPOSITORY) private readonly requests: IRxRequestRepository,
    @Inject(RX_REQUEST_PHARMACIES_PORT) private readonly pharmacies: IRxRequestPharmaciesPort,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepository,
    @Inject(DELIVERY_PRICING_PORT) private readonly deliveryPricing: IDeliveryPricingPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly checkout: CheckoutCommand,
    private readonly review: ReviewOrderPrescriptionCommand,
    private readonly pay: PayOrderCommand,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async quote(input: QuoteRxRequestInput, now = new Date()): Promise<RxRequestSnapshot> {
    if (!input.legibilityOk || !input.validityOk) {
      throw OrdersErrors.validation('Confirm the prescription is legible and valid before quoting.');
    }
    if (input.lines.length === 0) throw OrdersErrors.validation('Quote at least one medicine.', { field: 'lines' });
    const ids = input.lines.map((l) => l.catalogProductId);
    if (new Set(ids).size !== ids.length) throw OrdersErrors.validation('List each medicine once.', { field: 'lines' });

    const request = await this.requests.findById(input.requestId);
    const mine = await this.pharmacies.pharmaciesWherePharmacist(input.actorUserId);
    const holder = request?.claimedPharmacyId;
    if (!request || !holder || !mine.some((m) => m.pharmacyId === holder)) throw RxRequestErrors.notFound();
    if (request.status !== 'CLAIMED' || !request.claimExpiresAt || request.claimExpiresAt <= now) {
      throw RxRequestErrors.unavailable('Your pharmacy does not hold this request any more.');
    }
    const branchId = request.claimedBranchId as string;

    // Each medicine: sellable on the platform, in this branch's stock, never a prohibited substance.
    const sellable = await this.pharmacies.sellableAt(branchId, ids);
    const lines: RxQuoteLine[] = [];
    for (const line of input.lines) {
      const product = await this.catalog.getProduct(line.catalogProductId);
      if (!product || product.status !== 'ACTIVE') throw OrdersErrors.catalogProductUnavailable();
      const schedule = product.controlledSchedule ?? NO_SCHEDULE;
      if (schedule === PROHIBITED_SCHEDULE) {
        throw OrdersErrors.validation(`${product.name || 'This product'} cannot be sold on PharmaLink.`, { catalogProductId: product.id });
      }
      if ((sellable.get(line.catalogProductId) ?? 0) < line.quantity) {
        throw OrdersErrors.validation(`Your branch does not have ${line.quantity} of ${product.name || 'this product'} to sell. Update your stock, or quote less.`, {
          catalogProductId: product.id,
        });
      }
      lines.push({
        catalogProductId: product.id,
        name: product.name,
        quantity: line.quantity,
        unitPrice: product.price,
        lineTotal: product.price * line.quantity,
        controlledSchedule: schedule,
        requiresRx: RxClassificationPolicy.requiresPrescription(product.rxClassification),
      });
    }

    const schedules = lines.map((l) => l.controlledSchedule);
    const dateProblem = RxRequestPolicy.issueDateProblem(input.prescriptionIssueDate, now, RxRequestPolicy.maxAgeDays(this.config, schedules));
    if (dateProblem) throw RxRequestErrors.tooOld(dateProblem);

    const { deliveryFee } = await this.deliveryPricing.quote({ customerUserId: request.customerUserId, addressId: request.addressId, branchId });
    const totals = PricingCalculator.computeTotals({
      lines: lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity })),
      deliveryFee,
      platformFeePercent: this.config.get<number>('orders.platformFeePercent') ?? 0,
    });
    const quote: RxQuote = {
      lines,
      subtotal: totals.subtotal,
      deliveryFee: totals.deliveryFee,
      platformFee: totals.platformFee,
      grandTotal: totals.grandTotal,
      currency: totals.currency,
      paperRequired: input.paperRequired ?? schedules.some((s) => s !== NO_SCHEDULE),
      prescriptionIssueDate: input.prescriptionIssueDate.toISOString().slice(0, 10),
      legibilityOk: true,
      validityOk: true,
      quotedByUserId: input.actorUserId,
      note: input.note?.trim() || null,
    };

    await runWithOrderRetry(this.uow, async (tx) => {
      const saved = await this.requests.saveQuote(request.id, holder, quote, now, RxRequestPolicy.addMinutes(now, RxRequestPolicy.quoteResponseMinutes(this.config)), tx);
      if (!saved) throw RxRequestErrors.unavailable('Your pharmacy does not hold this request any more.');
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'RX_REQUEST_QUOTED',
          resourceType: 'RxRequest',
          resourceId: request.id,
          context: { pharmacyId: holder, grandTotal: quote.grandTotal, lines: lines.length, paperRequired: quote.paperRequired },
        },
        tx,
      );
      await this.outbox.write(
        rxRequestEvents.quoted({ requestId: request.id, customerUserId: request.customerUserId, grandTotal: quote.grandTotal, currency: quote.currency }),
        tx as never,
      );
    });
    return (await this.requests.findById(request.id)) as RxRequestSnapshot;
  }

  async confirm(input: ConfirmRxRequestInput, now = new Date()): Promise<{ request: RxRequestSnapshot; orderId: string }> {
    const request = await this.requests.findById(input.requestId);
    if (!request || request.customerUserId !== input.customerUserId) throw RxRequestErrors.notFound();
    if (request.orderId) return { request, orderId: request.orderId };
    const quote = request.quote as RxQuote | null;
    if (!quote || !request.claimedPharmacyId) throw RxRequestErrors.unavailable('There is no quote to confirm.');

    const confirmed = await runWithOrderRetry(this.uow, (tx) => this.requests.confirm(request.id, input.customerUserId, now, tx));
    if (!confirmed) throw RxRequestErrors.unavailable('This quote is no longer open. It expired or the request ended.');

    let placed: CheckoutResult;
    try {
      placed = await this.checkout.execute({
        customerUserId: input.customerUserId,
        addressId: request.addressId,
        idempotencyKey: rxRequestOrderKey(request.id),
        // The prepaid method marks the order prepaid; it is paid below, once the prescription is approved.
        ...(input.payment ? { payment: { method: input.payment.method } } : {}),
        prescriptionId: request.prescriptionId,
        paperRxRequired: quote.paperRequired,
        source: {
          pharmacyId: request.claimedPharmacyId,
          items: quote.lines.map((l) => ({ catalogProductId: l.catalogProductId, quantity: l.quantity, confirmedUnitPrice: l.unitPrice })),
        },
      });
    } catch (err) {
      // An order that was placed and then cancelled (a failed step) stays linked: the request is
      // answered. Nothing placed: the quote stays open for another try until it expires.
      const existing = await this.orders.findByIdempotencyKey(rxRequestOrderKey(request.id));
      if (existing) await this.requests.setOrder(request.id, existing.id);
      else await this.requests.unconfirm(request.id);
      throw err;
    }
    await this.requests.setOrder(request.id, placed.order.id);

    // The pharmacist reviewed the prescription when quoting; approve it on the order as them.
    if (placed.order.rxReviewStatus === 'PENDING') {
      await this.review.approve({ fulfillmentId: placed.fulfillment.id, actorUserId: quote.quotedByUserId, legibilityOk: quote.legibilityOk, validityOk: quote.validityOk });
    }
    // After the approval a COD order is paid; a prepaid one waits for its payment, made here.
    const order = await this.orders.findById(placed.order.id);
    if (input.payment && order?.status === 'PENDING_PAYMENT') {
      await this.pay.execute({ orderId: placed.order.id, customerUserId: input.customerUserId, payment: input.payment });
    }
    await this.audit.record({ actorUserId: input.customerUserId, action: 'RX_REQUEST_CONFIRMED', resourceType: 'RxRequest', resourceId: request.id, context: { orderId: placed.order.id } });
    return { request: (await this.requests.findById(request.id)) as RxRequestSnapshot, orderId: placed.order.id };
  }

  async declineQuote(input: { requestId: string; customerUserId: string }, now = new Date()): Promise<RxRequestSnapshot> {
    const request = await this.requests.findById(input.requestId);
    if (!request || request.customerUserId !== input.customerUserId) throw RxRequestErrors.notFound();
    if (request.status !== 'QUOTED') throw RxRequestErrors.unavailable('There is no open quote to decline.');
    const staff = await this.pharmacies.staffUserIds(request.claimedPharmacyId ? [request.claimedPharmacyId] : []);

    await runWithOrderRetry(this.uow, async (tx) => {
      const closed = await this.requests.close(request.id, ['QUOTED'], 'CANCELLED', RX_REQUEST_CLOSED_REASON.QUOTE_DECLINED, now, tx);
      if (!closed) throw RxRequestErrors.unavailable('There is no open quote to decline.');
      const moved = await this.requests.moveOffers(request.id, ['WON'], 'CLOSED', now, { reason: RX_REQUEST_CLOSED_REASON.QUOTE_DECLINED }, tx);
      await this.audit.record({ actorUserId: input.customerUserId, action: 'RX_REQUEST_QUOTE_DECLINED', resourceType: 'RxRequest', resourceId: request.id, context: {} }, tx);
      const recipientUserIds = [...new Set(moved.flatMap((id) => staff.get(id) ?? []))];
      if (recipientUserIds.length > 0) {
        await this.outbox.write(rxRequestEvents.withdrawn({ requestId: request.id, recipientUserIds, reason: RX_REQUEST_CLOSED_REASON.QUOTE_DECLINED }), tx as never);
      }
    });
    return (await this.requests.findById(request.id)) as RxRequestSnapshot;
  }
}
