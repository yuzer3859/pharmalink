import { FulfillmentSnapshot } from '../../domain/repositories/fulfillment.repository';
import { OrderLineSnapshot, OrderSnapshot } from '../../domain/repositories/order.repository';

/** Shared fixtures for Order/Fulfillment application-layer command/query specs — mirrors
 * `modules/prescription-matching/application/commands/*.spec.ts`'s own per-suite snapshot
 * builder convention (not a shared test-infrastructure module, per Step 15's "do not create a
 * new test infrastructure" instruction — this is just a small, local convenience). */
export function orderSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: 'order-1',
    orderNumber: 'ORD-0001',
    customerUserId: 'customer-1',
    beneficiarySnapshot: null,
    addressSnapshot: null,
    status: 'PAID',
    strategy: 'SINGLE',
    subtotal: 1000,
    deliveryFee: 100,
    platformFee: 50,
    discountTotal: 0,
    grandTotal: 1150,
    currency: 'ETB',
    paymentId: null,
    matchRequestId: 'match-1',
    deliverySlot: null,
    idempotencyKey: 'idem-1',
    isCod: true,
    placedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function orderLineSnapshot(overrides: Partial<OrderLineSnapshot> = {}): OrderLineSnapshot {
  return {
    id: 'line-1',
    orderId: 'order-1',
    catalogProductId: 'product-1',
    productSnapshot: null,
    quantity: 2,
    unitPrice: 500,
    lineTotal: 1000,
    fulfillmentId: 'fulfillment-1',
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    reservationId: 'reservation-1',
    prescriptionLineId: null,
    requiresRx: false,
    lineStatus: 'RESERVED',
    substitutedFromProductId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

export function fulfillmentSnapshot(overrides: Partial<FulfillmentSnapshot> = {}): FulfillmentSnapshot {
  return {
    id: 'fulfillment-1',
    orderId: 'order-1',
    pharmacyId: 'pharmacy-1',
    branchId: 'branch-1',
    status: 'PENDING',
    deliveryJobId: null,
    acceptedAt: null,
    readyAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}
