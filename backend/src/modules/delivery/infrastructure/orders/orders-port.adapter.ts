import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  DeliverableFulfillmentView,
  DeliverableLineView,
  IOrdersPort,
} from '../../application/ports/outbound/orders.port';

/**
 * The one Module 06 `FulfillmentStatus` from which a delivery job may be cut (BRULE-27,
 * F-JOB-01).
 *
 * `READY` is the design's "ready for pickup": Module 06's `MarkReadyCommand` reaches it after
 * stock has been dispatched and any prescription dispensed, and it is the transition that emits
 * `order.ready`. `DISPATCHED` and `DELIVERED` are Module 08's own later effects on the
 * fulfillment, so a job cut from either would be a second job for work already in flight.
 */
const DELIVERABLE_STATUS = 'READY';

/**
 * Module 08's own `IOrdersPort` adapter — a direct, in-process `PrismaService` read of Module
 * 06's `fulfillments`, `orders` and `order_lines` (ADR-002), never a Prisma relation across the
 * context boundary. Own copy, mirroring the adapters Modules 06 and 07 each keep.
 *
 * **Read-only, and it projects rather than returns rows.** The order carries pricing, a payment
 * id, a match request, Rx flags per line; none of that reaches the delivery module, because the
 * `select` clauses below do not ask for it. That is the boundary enforced at the narrowest point
 * it can be — a field never read cannot be leaked onto a driver's screen by a later change.
 *
 * Only the lines belonging to *this fulfillment* are read. An order split across two pharmacies
 * has two jobs, and each driver must see only their own pickup's items (§5.3).
 */
@Injectable()
export class OrdersPortAdapter implements IOrdersPort {
  constructor(private readonly prisma: PrismaService) {}

  async getDeliverableFulfillment(
    fulfillmentId: string,
  ): Promise<DeliverableFulfillmentView | null> {
    const fulfillment = await this.prisma.fulfillment.findUnique({
      where: { id: fulfillmentId },
      select: {
        id: true,
        orderId: true,
        pharmacyId: true,
        branchId: true,
        status: true,
        deliveryJobId: true,
      },
    });
    if (!fulfillment) {
      return null;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: fulfillment.orderId },
      select: {
        isCod: true,
        grandTotal: true,
        deliveryFee: true,
        currency: true,
        addressSnapshot: true,
      },
    });
    if (!order) {
      // A fulfillment whose order is gone is a Module 06 integrity problem, not a delivery one.
      // Reported as "not deliverable" rather than crashing: the caller is an event handler, and
      // the distinction it needs is only "may I cut a job?".
      return null;
    }

    const lines = await this.prisma.orderLine.findMany({
      where: { orderId: fulfillment.orderId, fulfillmentId: fulfillment.id },
      select: { catalogProductId: true, productSnapshot: true, quantity: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      fulfillmentId: fulfillment.id,
      orderId: fulfillment.orderId,
      pharmacyId: fulfillment.pharmacyId,
      branchId: fulfillment.branchId,
      status: fulfillment.status,
      isReadyForDelivery: fulfillment.status === DELIVERABLE_STATUS,
      deliveryJobId: fulfillment.deliveryJobId,
      isCod: order.isCod,
      orderTotal: order.grandTotal,
      deliveryFee: order.deliveryFee,
      currency: order.currency,
      dropoff: toDropoff(order.addressSnapshot),
      lines: lines.map(toLine),
    };
  }

  /**
   * One column of one row (§9.4's order-ownership check).
   *
   * The `select` is the boundary again: this reads `customerUserId` and nothing else, so the
   * tracking authorization path is structurally incapable of picking up a total, a payment id or
   * an address on its way past. A missing order answers `null` and the caller turns that into the
   * same `NOT_FOUND` an unauthorized one gets.
   */
  async getOrderCustomerUserId(orderId: string): Promise<string | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerUserId: true },
    });
    return order?.customerUserId ?? null;
  }
}

/**
 * `Order.addressSnapshot` is `Json?`, written by Module 06's checkout as
 * `{ line1, city, lat, lng }`. Read defensively field by field rather than cast: it is another
 * context's JSON column, and a shape change there must degrade to a missing field here, never to
 * a thrown error inside an event handler.
 */
function toDropoff(snapshot: unknown): DeliverableFulfillmentView['dropoff'] {
  const record = asRecord(snapshot);
  if (!record) {
    return null;
  }
  return {
    lat: asNumber(record.lat),
    lng: asNumber(record.lng),
    line1: asText(record.line1),
    city: asText(record.city),
  };
}

function toLine(row: {
  catalogProductId: string;
  productSnapshot: unknown;
  quantity: number;
}): DeliverableLineView {
  const snapshot = asRecord(row.productSnapshot);
  return {
    catalogProductId: row.catalogProductId,
    // The name the customer saw when they ordered. Falling back to the id rather than to an empty
    // string keeps the item identifiable on a driver's manifest even if the snapshot is missing.
    name: asText(snapshot?.name) ?? row.catalogProductId,
    quantity: row.quantity,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
