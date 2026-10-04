import { Injectable } from '@nestjs/common';
import {
  Invoice as PrismaInvoice,
  Order as PrismaOrder,
  OrderLine as PrismaOrderLine,
  OrderStatusHistory as PrismaOrderStatusHistory,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  InvoiceSnapshot,
  IOrderRepository,
  ListOrdersCriteria,
  NewInvoiceData,
  NewOrderData,
  NewOrderLineData,
  NewOrderStatusHistoryEntryData,
  OrderLineFulfillmentReassignment,
  OrderLineSnapshot,
  OrderSnapshot,
  OrderStatusHistoryEntrySnapshot,
  OrderStatusUpdate,
  PagedResult,
} from '../../domain/repositories/order.repository';

type Client = PrismaService | Prisma.TransactionClient;

/**
 * Prisma requires the `Prisma.DbNull` sentinel (not a plain `null`) to write SQL `NULL` into a
 * nullable `Json` column — mirrors `modules/prescription-matching/infrastructure/persistence/
 * prisma-match.repository.ts`'s `chosenResultToJsonInput` precedent, applied here to `Order.
 * beneficiarySnapshot`/`addressSnapshot`/`OrderLine.productSnapshot`.
 */
function jsonInput(
  value: Record<string, unknown> | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function optionalJsonInput(
  value: Record<string, unknown> | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  return value === undefined ? undefined : jsonInput(value);
}

function fromJson(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return (value as unknown as Record<string, unknown> | null) ?? null;
}

function toOrderSnapshot(row: PrismaOrder): OrderSnapshot {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    customerUserId: row.customerUserId,
    beneficiarySnapshot: fromJson(row.beneficiarySnapshot),
    addressSnapshot: fromJson(row.addressSnapshot),
    status: row.status,
    strategy: row.strategy,
    subtotal: row.subtotal,
    deliveryFee: row.deliveryFee,
    platformFee: row.platformFee,
    discountTotal: row.discountTotal,
    grandTotal: row.grandTotal,
    currency: row.currency,
    paymentId: row.paymentId,
    matchRequestId: row.matchRequestId,
    deliverySlot: row.deliverySlot,
    idempotencyKey: row.idempotencyKey,
    isCod: row.isCod,
    placedAt: row.placedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOrderLineSnapshot(row: PrismaOrderLine): OrderLineSnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    catalogProductId: row.catalogProductId,
    productSnapshot: fromJson(row.productSnapshot),
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    lineTotal: row.lineTotal,
    fulfillmentId: row.fulfillmentId,
    pharmacyId: row.pharmacyId,
    branchId: row.branchId,
    reservationId: row.reservationId,
    prescriptionLineId: row.prescriptionLineId,
    requiresRx: row.requiresRx,
    lineStatus: row.lineStatus,
    substitutedFromProductId: row.substitutedFromProductId,
    createdAt: row.createdAt,
  };
}

function toHistorySnapshot(row: PrismaOrderStatusHistory): OrderStatusHistoryEntrySnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    event: row.event,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function toInvoiceSnapshot(row: PrismaInvoice): InvoiceSnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    invoiceNumber: row.invoiceNumber,
    pdfRef: row.pdfRef,
    totals: fromJson(row.totals),
    issuedAt: row.issuedAt,
  };
}

/**
 * Prisma adapter for `IOrderRepository` (module-06 `06-orders-spec.md` §3.3/§3.7/§3.8/§3.9, §14
 * step 4) — persists the `Order` aggregate root, its child `OrderLine` rows, its append-only
 * `OrderStatusHistory` ledger, and its 1:1 `Invoice` row via `orders` / `order_lines` /
 * `order_status_history` / `invoices` (`prisma/schema/06-orders.prisma`). Follows the same
 * `tx?: unknown` pass-through convention as every other Module 05/06 repository adapter — this
 * adapter never opens its own `$transaction()`; the caller-supplied `IUnitOfWork` owns that
 * boundary (§11).
 *
 * `create()` writes the `Order` header and its initial `OrderStatusHistory` row via one nested
 * Prisma `create()` call (`statusHistory: { create: {...} }`), and `updateStatus()` writes the
 * status change and its history row as two statements against the same caller-supplied client —
 * in both cases, atomicity across the two rows is guaranteed by the caller running these calls
 * inside one `Serializable` transaction (§3.11 invariant 3, §11), never by this adapter opening
 * its own transaction.
 *
 * `OrderStatusPolicy`/`CancellationPolicy` remain the sole authorities on which transitions are
 * legal — this repository persists whichever already-validated state the caller supplies.
 */
@Injectable()
export class PrismaOrderRepository implements IOrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<OrderSnapshot | null> {
    const row = await this.client(tx).order.findUnique({ where: { id } });
    return row ? toOrderSnapshot(row) : null;
  }

  async findByOrderNumber(orderNumber: string, tx?: unknown): Promise<OrderSnapshot | null> {
    const row = await this.client(tx).order.findUnique({ where: { orderNumber } });
    return row ? toOrderSnapshot(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string, tx?: unknown): Promise<OrderSnapshot | null> {
    const row = await this.client(tx).order.findUnique({ where: { idempotencyKey } });
    return row ? toOrderSnapshot(row) : null;
  }

  async listByCustomer(
    criteria: ListOrdersCriteria,
    tx?: unknown,
  ): Promise<PagedResult<OrderSnapshot>> {
    const client = this.client(tx);
    const where: Prisma.OrderWhereInput = {
      customerUserId: criteria.customerUserId,
      status: criteria.status,
    };
    const [items, total] = await Promise.all([
      client.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (criteria.page - 1) * criteria.size,
        take: criteria.size,
      }),
      client.order.count({ where }),
    ]);
    return { items: items.map(toOrderSnapshot), total };
  }

  async create(
    data: NewOrderData,
    initialHistoryEntry: NewOrderStatusHistoryEntryData,
    tx?: unknown,
  ): Promise<OrderSnapshot> {
    const row = await this.client(tx).order.create({
      data: {
        orderNumber: data.orderNumber,
        customerUserId: data.customerUserId,
        beneficiarySnapshot: jsonInput(data.beneficiarySnapshot),
        addressSnapshot: jsonInput(data.addressSnapshot),
        status: data.status,
        strategy: data.strategy ?? 'SINGLE',
        subtotal: data.subtotal,
        deliveryFee: data.deliveryFee,
        platformFee: data.platformFee,
        discountTotal: data.discountTotal,
        grandTotal: data.grandTotal,
        currency: data.currency ?? 'ETB',
        matchRequestId: data.matchRequestId ?? null,
        deliverySlot: data.deliverySlot ?? null,
        idempotencyKey: data.idempotencyKey,
        isCod: data.isCod,
        placedAt: data.placedAt ?? null,
        statusHistory: {
          create: {
            fromStatus: initialHistoryEntry.fromStatus,
            toStatus: initialHistoryEntry.toStatus,
            event: initialHistoryEntry.event ?? null,
            actorUserId: initialHistoryEntry.actorUserId ?? null,
            actorRole: initialHistoryEntry.actorRole ?? null,
            reason: initialHistoryEntry.reason ?? null,
          },
        },
      },
    });
    return toOrderSnapshot(row);
  }

  async updateStatus(
    id: string,
    update: OrderStatusUpdate,
    historyEntry: NewOrderStatusHistoryEntryData,
    tx?: unknown,
  ): Promise<void> {
    const client = this.client(tx);
    await client.order.update({
      where: { id },
      data: {
        status: update.status,
        placedAt: update.placedAt,
        completedAt: update.completedAt,
        cancelledAt: update.cancelledAt,
        cancelReason: update.cancelReason,
        matchRequestId: update.matchRequestId,
      },
    });
    await client.orderStatusHistory.create({
      data: {
        orderId: id,
        fromStatus: historyEntry.fromStatus,
        toStatus: historyEntry.toStatus,
        event: historyEntry.event ?? null,
        actorUserId: historyEntry.actorUserId ?? null,
        actorRole: historyEntry.actorRole ?? null,
        reason: historyEntry.reason ?? null,
      },
    });
  }

  async findStatusHistory(
    orderId: string,
    tx?: unknown,
  ): Promise<OrderStatusHistoryEntrySnapshot[]> {
    const rows = await this.client(tx).orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toHistorySnapshot);
  }

  async createLines(
    orderId: string,
    lines: NewOrderLineData[],
    tx?: unknown,
  ): Promise<OrderLineSnapshot[]> {
    const client = this.client(tx);
    const rows = await Promise.all(
      lines.map((line) =>
        client.orderLine.create({
          data: {
            orderId,
            catalogProductId: line.catalogProductId,
            productSnapshot: optionalJsonInput(line.productSnapshot),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            fulfillmentId: line.fulfillmentId ?? null,
            pharmacyId: line.pharmacyId ?? null,
            branchId: line.branchId ?? null,
            reservationId: line.reservationId ?? null,
            prescriptionLineId: line.prescriptionLineId ?? null,
            requiresRx: line.requiresRx ?? false,
            lineStatus: line.lineStatus ?? 'PENDING',
          },
        }),
      ),
    );
    return rows.map(toOrderLineSnapshot);
  }

  async findLinesByOrderId(orderId: string, tx?: unknown): Promise<OrderLineSnapshot[]> {
    const rows = await this.client(tx).orderLine.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toOrderLineSnapshot);
  }

  async updateLineFulfillment(
    orderLineId: string,
    data: OrderLineFulfillmentReassignment,
    tx?: unknown,
  ): Promise<void> {
    await this.client(tx).orderLine.update({
      where: { id: orderLineId },
      data: {
        fulfillmentId: data.fulfillmentId,
        pharmacyId: data.pharmacyId,
        branchId: data.branchId,
        reservationId: data.reservationId,
      },
    });
  }

  async createInvoice(
    orderId: string,
    data: NewInvoiceData,
    tx?: unknown,
  ): Promise<InvoiceSnapshot> {
    const row = await this.client(tx).invoice.create({
      data: {
        orderId,
        invoiceNumber: data.invoiceNumber,
        totals: jsonInput(data.totals),
      },
    });
    return toInvoiceSnapshot(row);
  }

  async findInvoiceByOrderId(orderId: string, tx?: unknown): Promise<InvoiceSnapshot | null> {
    const row = await this.client(tx).invoice.findUnique({ where: { orderId } });
    return row ? toInvoiceSnapshot(row) : null;
  }
}
