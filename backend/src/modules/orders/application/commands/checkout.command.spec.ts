import {
  DeliveryPricingQuote,
  IDeliveryPricingPort,
} from '../../../delivery/application/ports/inbound/delivery-pricing.port';
import { AuditService } from '../../../../shared/audit/audit.service';
import { IConfigPort } from '../../../../shared/config/config.port';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  ICouponPort,
} from '../../../payment/application/ports/inbound/coupon.port';
import { ICheckRxGatePort } from '../../../prescription-matching/application/ports/inbound/check-rx-gate.port';
import { IMatchingPort } from '../../../prescription-matching/application/ports/inbound/matching.port';
import { CartSnapshot, ICartRepository } from '../../domain/repositories/cart.repository';
import { IFulfillmentRepository } from '../../domain/repositories/fulfillment.repository';
import { IOrderRepository, InvoiceSnapshot } from '../../domain/repositories/order.repository';
import { IAddressPort } from '../ports/outbound/address.port';
import { ICatalogPort } from '../ports/outbound/catalog.port';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { CheckoutCommand } from './checkout.command';
import { fulfillmentSnapshot, orderLineSnapshot, orderSnapshot } from './test-fixtures';

/**
 * A delivery quote shaped exactly as `QuoteDeliveryFeeQuery` returns one.
 *
 * `deliveryFee` is the only field Module 06 consumes — `PricingCalculator` takes an amount and
 * nothing else — so the rest is present to keep the fake honest to the real contract rather than
 * because anything here reads it.
 */
function deliveryQuote(deliveryFee: number): DeliveryPricingQuote {
  return {
    branchId: 'branch-1',
    pharmacyId: 'pharmacy-1',
    distanceMeters: 4_200,
    estimatedDurationSeconds: 690,
    basis: 'DISTANCE',
    zoneId: null,
    baseFee: deliveryFee,
    distanceFee: 0,
    deliveryFee,
    currency: 'ETB',
    pricingVersion: 'v1',
  };
}

function cartSnapshot(overrides: Partial<CartSnapshot> = {}): CartSnapshot {
  return {
    id: 'cart-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'ACTIVE',
    items: [
      {
        id: 'item-1',
        cartId: 'cart-1',
        catalogProductId: 'product-1',
        quantity: 2,
        indicativePrice: 500,
        requiresRx: false,
        addedAt: new Date(),
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function invoiceSnapshot(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: 'invoice-1',
    orderId: 'order-1',
    invoiceNumber: 'INV-0001',
    pdfRef: null,
    totals: { grandTotal: 1000 },
    issuedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const cart = cartSnapshot();
  const carts: jest.Mocked<ICartRepository> = {
    findActiveByCustomer: jest.fn().mockResolvedValue(cart),
    findById: jest.fn(),
    create: jest.fn(),
    findItemById: jest.fn(),
    addItem: jest.fn(),
    updateItemQuantity: jest.fn(),
    removeItem: jest.fn(),
    reconcileItemPrice: jest.fn(),
    clearItems: jest.fn(),
    markConverted: jest.fn().mockResolvedValue(undefined),
  };

  const createdOrder = orderSnapshot({ status: 'PENDING_PAYMENT' });
  const paidOrder = orderSnapshot({ status: 'PAID' });
  const createdLines = [orderLineSnapshot()];
  const createdFulfillment = fulfillmentSnapshot();
  const createdInvoice = invoiceSnapshot();

  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn().mockResolvedValue(paidOrder),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    listByCustomer: jest.fn(),
    create: jest.fn().mockResolvedValue(createdOrder),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    findStatusHistory: jest.fn(),
    createLines: jest.fn().mockResolvedValue(createdLines),
    findLinesByOrderId: jest.fn().mockResolvedValue(createdLines),
    updateLineFulfillment: jest.fn(),
    createInvoice: jest.fn().mockResolvedValue(createdInvoice),
    findInvoiceByOrderId: jest.fn().mockResolvedValue(createdInvoice),
  };

  const fulfillments: jest.Mocked<IFulfillmentRepository> = {
    findById: jest.fn(),
    findByOrderId: jest.fn().mockResolvedValue([createdFulfillment]),
    create: jest.fn().mockResolvedValue(createdFulfillment),
    updateStatus: jest.fn(),
    listByPharmacyIds: jest.fn(),
  };

  const catalog: jest.Mocked<ICatalogPort> = {
    getProduct: jest.fn().mockResolvedValue({
      id: 'product-1',
      status: 'ACTIVE',
      rxClassification: null,
      price: 500,
      name: 'Paracetamol 500mg',
    }),
  };

  const addresses: jest.Mocked<IAddressPort> = {
    getAddress: jest.fn().mockResolvedValue({
      lat: 9.03,
      lng: 38.74,
      line1: 'Bole Road',
      city: 'Addis Ababa',
    }),
  };

  const checkRxGate: jest.Mocked<ICheckRxGatePort> = {
    check: jest.fn().mockResolvedValue({ allowed: true, blocked: [], usablePrescriptionLineIds: [] }),
  };

  const matching: jest.Mocked<IMatchingPort> = {
    find: jest.fn().mockResolvedValue({
      matchRequest: {
        id: 'match-1',
        orderId: null,
        customerUserId: 'customer-1',
        deliveryLat: 9.03,
        deliveryLng: 38.74,
        status: 'PENDING',
        strategy: 'SINGLE',
        chosenResult: null,
        overridePharmacyId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      candidates: [],
    }),
    select: jest.fn().mockResolvedValue({
      id: 'match-1',
      orderId: null,
      customerUserId: 'customer-1',
      deliveryLat: 9.03,
      deliveryLng: 38.74,
      status: 'MATCHED',
      strategy: 'SINGLE',
      chosenResult: {
        pharmacyId: 'pharmacy-1',
        branchId: 'branch-1',
        lines: [
          { catalogProductId: 'product-1', listingId: 'listing-1', reservationId: 'reservation-1', quantity: 2 },
        ],
      },
      overridePharmacyId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    rematch: jest.fn(),
  };

  const inventory: jest.Mocked<IInventoryPort> = {
    reserve: jest.fn(),
    confirm: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    dispatch: jest.fn(),
    getReservationFulfillment: jest.fn(),
  };

  const config: jest.Mocked<IConfigPort> = {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn(),
    isFeatureEnabled: jest.fn(),
  };

  /**
   * Module 07's coupon seam. Defaults to "no coupon was asked for", so every pre-existing test
   * behaves exactly as before: `quoteCoupon` returns `0` without calling `validate` at all when
   * `couponCode` is absent, and `redeemCoupon` is never reached.
   */
  const coupons: jest.Mocked<ICouponPort> = {
    validate: jest.fn(),
    apply: jest.fn(),
    reverse: jest.fn(),
  };

  /**
   * The delivery fee Module 08 answers with. Zero throughout, matching this suite's existing
   * `grandTotal === subtotal` expectations and the platform's shipped rate card, which is empty.
   */
  const deliveryPricing: jest.Mocked<IDeliveryPricingPort> = {
    quote: jest.fn().mockResolvedValue(deliveryQuote(0)),
  };

  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  const command = new CheckoutCommand(
    carts,
    orders,
    fulfillments,
    catalog,
    addresses,
    checkRxGate,
    matching,
    inventory,
    coupons,
    deliveryPricing,
    config,
    uow,
    audit,
    outbox,
  );

  return {
    command,
    coupons,
    deliveryPricing,
    carts,
    orders,
    fulfillments,
    catalog,
    addresses,
    checkRxGate,
    matching,
    inventory,
    config,
    audit,
    outbox,
    cart,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    customerUserId: 'customer-1',
    addressId: 'address-1',
    idempotencyKey: 'idem-checkout-1',
    ...overrides,
  };
}

describe('CheckoutCommand', () => {
  it('places a COD order end-to-end: creates order/lines/fulfillment/invoice, confirms PAID, finalizes the cart', async () => {
    const { command, orders, fulfillments, carts, audit, outbox } = build();

    const result = await command.execute(input());

    expect(orders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerUserId: 'customer-1',
        status: 'PENDING_PAYMENT',
        isCod: true,
        idempotencyKey: 'idem-checkout-1',
        matchRequestId: 'match-1',
      }),
      expect.objectContaining({ toStatus: 'PENDING_PAYMENT' }),
      undefined,
    );
    expect(fulfillments.create).toHaveBeenCalledWith(
      { orderId: 'order-1', pharmacyId: 'pharmacy-1', branchId: 'branch-1' },
      undefined,
    );
    expect(orders.createLines).toHaveBeenCalledWith(
      'order-1',
      [
        expect.objectContaining({
          catalogProductId: 'product-1',
          quantity: 2,
          unitPrice: 500,
          lineTotal: 1000,
          reservationId: 'reservation-1',
          requiresRx: false,
          prescriptionLineId: null,
        }),
      ],
      undefined,
    );
    expect(orders.createInvoice).toHaveBeenCalled();
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'order-1',
      { status: 'PAID' },
      expect.objectContaining({ toStatus: 'PAID', event: 'COD_CONFIRMED' }),
      undefined,
    );
    expect(carts.markConverted).toHaveBeenCalledWith('cart-1', undefined);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_PLACED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(2);
    expect(result.replay).toBe(false);
    expect(result.order.status).toBe('PAID');
  });

  // The order total tracks the *catalog* read, not the cart row: both cases below pass the
  // spec-10 confirmation gate (cached price == catalog price, i.e. the customer has re-quoted),
  // yet the resulting total moves with the catalog value alone. Checkout charging the fresh
  // catalog price remains true (spec 3.12 invariant 2); the cache only gates whether checkout may
  // run — see the "price confirmation" block above for the divergent case.
  it.each([
    [500, 1000],
    [999, 1998],
  ])(
    'computes authoritative pricing from the fresh catalog price %i (subtotal %i), never the cart row',
    async (catalogPrice, expectedSubtotal) => {
      const { command, catalog, carts, orders } = build();
      catalog.getProduct.mockResolvedValue({
        id: 'product-1',
        status: 'ACTIVE',
        rxClassification: null,
        price: catalogPrice,
        name: 'Paracetamol 500mg',
      });
      carts.findActiveByCustomer.mockResolvedValue(
        cartSnapshot({
          items: [
            {
              id: 'item-1',
              cartId: 'cart-1',
              catalogProductId: 'product-1',
              quantity: 2,
              indicativePrice: catalogPrice,
              requiresRx: false,
              addedAt: new Date(),
            },
          ],
        }),
      );

      await command.execute(input());

      expect(catalog.getProduct).toHaveBeenCalledWith('product-1');
      expect(orders.create).toHaveBeenCalledWith(
        expect.objectContaining({ subtotal: expectedSubtotal, grandTotal: expectedSubtotal }),
        expect.anything(),
        undefined,
      );
    },
  );

  it('rejects when the customer has no active cart at all', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects when the cart exists but has no items', async () => {
    const { command, carts, cart } = build();
    carts.findActiveByCustomer.mockResolvedValue({ ...cart, items: [] });

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('404s when the address does not exist / is not owned by the customer', async () => {
    const { command, addresses } = build();
    addresses.getAddress.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a missing/inactive catalog product', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
  });

  describe('Rx gate', () => {
    it('does not call ICheckRxGatePort at all when the cart has no Rx items', async () => {
      const { command, checkRxGate } = build();

      await command.execute(input());

      expect(checkRxGate.check).not.toHaveBeenCalled();
    });

    it('does not call ICheckRxGatePort for an OTC medicine (rxClassification "OTC")', async () => {
      // Regression: `Boolean(rxClassification)` was true for the string 'OTC', so every OTC
      // medicine was gated and blocked with RX_REQUIRED. `rxClassification` is mandatory for
      // MEDICINE (module-03 §3.6 invariant 1), so OTC medicines are the common case, not an edge.
      const { command, catalog, checkRxGate, orders } = build();
      catalog.getProduct.mockResolvedValue({
        id: 'product-1',
        status: 'ACTIVE',
        rxClassification: 'OTC',
        price: 500,
        name: 'Paracetamol 500mg',
      });

      await command.execute(input());

      expect(checkRxGate.check).not.toHaveBeenCalled();
      expect(orders.createLines).toHaveBeenCalledWith(
        'order-1',
        [expect.objectContaining({ requiresRx: false, prescriptionLineId: null })],
        undefined,
      );
    });

    it('calls the Rx gate once per Rx product and resolves prescriptionLineId per line', async () => {
      const { command, catalog, checkRxGate, orders } = build();
      catalog.getProduct.mockResolvedValue({
        id: 'product-1',
        status: 'ACTIVE',
        rxClassification: 'RX',
        price: 500,
        name: 'Amoxicillin 500mg',
      });
      checkRxGate.check.mockResolvedValue({
        allowed: true,
        blocked: [],
        usablePrescriptionLineIds: ['prescription-line-1'],
      });

      await command.execute(input());

      expect(checkRxGate.check).toHaveBeenCalledTimes(1);
      expect(checkRxGate.check).toHaveBeenCalledWith({
        customerUserId: 'customer-1',
        items: [{ catalogProductId: 'product-1', quantity: 2 }],
      });
      expect(orders.createLines).toHaveBeenCalledWith(
        'order-1',
        [expect.objectContaining({ prescriptionLineId: 'prescription-line-1', requiresRx: true })],
        undefined,
      );
    });

    it('blocks checkout (reusing the gate-reported error code) when the Rx gate rejects a line', async () => {
      const { command, catalog, checkRxGate, orders } = build();
      catalog.getProduct.mockResolvedValue({
        id: 'product-1',
        status: 'ACTIVE',
        rxClassification: 'RX',
        price: 500,
        name: 'Amoxicillin 500mg',
      });
      checkRxGate.check.mockResolvedValue({
        allowed: false,
        blocked: [{ catalogProductId: 'product-1', reason: ErrorCode.RX_REQUIRED }],
        usablePrescriptionLineIds: [],
      });

      await expect(command.execute(input())).rejects.toMatchObject({ code: 'RX_REQUIRED' });
      expect(orders.create).not.toHaveBeenCalled();
    });
  });

  describe('matching', () => {
    it('propagates NO_PHARMACY_MATCH without creating an order or reserving anything', async () => {
      const { command, matching, orders, inventory } = build();
      matching.find.mockRejectedValue(Object.assign(new Error('no match'), { code: 'NO_PHARMACY_MATCH' }));

      await expect(command.execute(input())).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
      expect(orders.create).not.toHaveBeenCalled();
      expect(inventory.release).not.toHaveBeenCalled();
    });

    it('propagates a select() failure (e.g. INSUFFICIENT_STOCK) without creating an order', async () => {
      const { command, matching, orders } = build();
      matching.select.mockRejectedValue(Object.assign(new Error('no stock'), { code: 'INSUFFICIENT_STOCK' }));

      await expect(command.execute(input())).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect(orders.create).not.toHaveBeenCalled();
    });
  });

  describe('compensation', () => {
    it('releases the reservation when order creation fails locally', async () => {
      const { command, orders, inventory } = build();
      orders.create.mockRejectedValue(new Error('db unavailable'));

      await expect(command.execute(input())).rejects.toThrow('db unavailable');
      expect(inventory.release).toHaveBeenCalledWith({
        reservationId: 'reservation-1',
        reason: 'checkout-order-creation-failed',
      });
    });

    it('releases the reservation when fulfillment creation fails locally', async () => {
      const { command, fulfillments, inventory } = build();
      fulfillments.create.mockRejectedValue(new Error('db unavailable'));

      await expect(command.execute(input())).rejects.toThrow('db unavailable');
      expect(inventory.release).toHaveBeenCalledWith({
        reservationId: 'reservation-1',
        reason: 'checkout-order-creation-failed',
      });
    });
  });

  describe('price confirmation (spec 10 — PRICE_CHANGED)', () => {
    it('rejects with PRICE_CHANGED when the fresh catalog price differs from the confirmed one', async () => {
      const { command, catalog, orders, matching, inventory } = build();
      // Cart confirmed at 500 (see cartSnapshot); Catalog has since moved to 999.
      catalog.getProduct.mockResolvedValue({
        id: 'product-1',
        status: 'ACTIVE',
        rxClassification: null,
        price: 999,
        name: 'Paracetamol 500mg',
      });

      await expect(command.execute(input())).rejects.toMatchObject({ code: 'PRICE_CHANGED' });

      // Raised before matching/reservation, so a rejected checkout holds no stock and creates
      // nothing to compensate.
      expect(matching.find).not.toHaveBeenCalled();
      expect(matching.select).not.toHaveBeenCalled();
      expect(inventory.confirm).not.toHaveBeenCalled();
      expect(inventory.release).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('reports the confirmed and current price per line so the client can re-quote', async () => {
      const { command, catalog } = build();
      catalog.getProduct.mockResolvedValue({
        id: 'product-1',
        status: 'ACTIVE',
        rxClassification: null,
        price: 999,
        name: 'Paracetamol 500mg',
      });

      await expect(command.execute(input())).rejects.toMatchObject({
        details: {
          items: [{ catalogProductId: 'product-1', confirmedPrice: 500, currentPrice: 999 }],
        },
      });
    });

    it('proceeds normally when the fresh price matches the confirmed one', async () => {
      const { command, orders } = build();

      const result = await command.execute(input());

      expect(result.replay).toBe(false);
      expect(orders.create).toHaveBeenCalledTimes(1);
    });

    it('still prices the order from the fresh catalog read, never the cached value', async () => {
      // The confirmation check gates *whether* checkout runs; it never makes the cache the
      // charged price. Cache and catalog agree here, and the order is priced from the catalog.
      const { command, orders } = build();

      await command.execute(input());

      expect(orders.create).toHaveBeenCalledWith(
        expect.objectContaining({ subtotal: 1000, grandTotal: 1000 }),
        expect.anything(),
        undefined,
      );
    });
  });

  describe('reservation confirmation (module-04 §8 — confirm on payment success)', () => {
    it('confirms every reservation before the order transaction runs', async () => {
      const { command, inventory, orders } = build();
      const sequence: string[] = [];
      const created = orderSnapshot({ status: 'PENDING_PAYMENT' });
      inventory.confirm.mockImplementation(async ({ reservationId }) => {
        sequence.push(`confirm:${reservationId}`);
      });
      orders.create.mockImplementation(async () => {
        sequence.push('order.create');
        return created;
      });

      await command.execute(input());

      expect(inventory.confirm).toHaveBeenCalledWith({ reservationId: 'reservation-1' });
      // Confirmation precedes persistence: an unconfirmed HELD hold would be TTL-swept out from
      // under a paid order, and dispatch at mark-ready requires CONFIRMED.
      expect(sequence).toEqual(['confirm:reservation-1', 'order.create']);
    });

    it('uses only the reservation ids resolved from matching, never caller input', async () => {
      const { command, inventory } = build();

      await command.execute({ ...input(), reservationId: 'attacker-supplied' } as never);

      expect(inventory.confirm).toHaveBeenCalledTimes(1);
      expect(inventory.confirm).toHaveBeenCalledWith({ reservationId: 'reservation-1' });
    });

    it('releases the reservation and creates no order when confirmation fails', async () => {
      const { command, inventory, orders } = build();
      inventory.confirm.mockRejectedValue(
        Object.assign(new Error('gone'), { code: 'INVALID_RESERVATION_STATE' }),
      );

      await expect(command.execute(input())).rejects.toMatchObject({
        code: 'INVALID_RESERVATION_STATE',
      });
      expect(orders.create).not.toHaveBeenCalled();
      expect(inventory.release).toHaveBeenCalledWith({
        reservationId: 'reservation-1',
        reason: 'checkout-reservation-confirm-failed',
      });
    });

    it('is not re-issued when the local Serializable transaction retries', async () => {
      // Confirm sits outside `runWithOrderRetry`'s callback deliberately: it is a cross-module
      // call owning its own transaction (ADR-014), so a serialization retry of *this* module's
      // transaction must not replay it. Module 04 would no-op the repeat anyway (its
      // `ConfirmReservationCommand` returns early on an already-CONFIRMED row), but relying on
      // that would be relying on the downstream module for our own call discipline.
      const { command, inventory, orders } = build();
      let attempts = 0;
      (command as unknown as { uow: IUnitOfWork }).uow = {
        run: async (work) => {
          attempts += 1;
          const result = await work(undefined);
          if (attempts < 2) {
            throw Object.assign(new Error('conflict'), { code: 'P2034' });
          }
          return result;
        },
      };

      await command.execute(input());

      expect(attempts).toBe(2);
      expect(orders.create).toHaveBeenCalledTimes(2);
      expect(inventory.confirm).toHaveBeenCalledTimes(1);
    });

    it('does not re-confirm on an idempotent replay (the original attempt already did)', async () => {
      const { command, inventory, orders } = build();
      orders.findByIdempotencyKey.mockResolvedValue(orderSnapshot({ status: 'PAID' }));

      const result = await command.execute(input());

      expect(result.replay).toBe(true);
      expect(inventory.confirm).not.toHaveBeenCalled();
    });
  });

  describe('transaction retry (§11)', () => {
    it('retries the local transaction on a Serializable write conflict and succeeds on a later attempt', async () => {
      const { command, orders } = build();
      let attempts = 0;
      (command as unknown as { uow: IUnitOfWork }).uow = {
        run: async (work) => {
          attempts += 1;
          const result = await work(undefined);
          if (attempts < 2) {
            throw Object.assign(new Error('conflict'), { code: 'P2034' });
          }
          return result;
        },
      };

      const result = await command.execute(input());

      expect(attempts).toBe(2);
      expect(result.replay).toBe(false);
      expect(orders.create).toHaveBeenCalledTimes(2); // work() re-executed from the beginning
    });
  });

  describe('idempotency', () => {
    it('replays the already-committed order for the same customer + key without redoing any work', async () => {
      const { command, orders, catalog, matching, carts } = build();
      orders.findByIdempotencyKey.mockResolvedValue(orderSnapshot({ status: 'PAID' }));

      const result = await command.execute(input());

      expect(result.replay).toBe(true);
      expect(catalog.getProduct).not.toHaveBeenCalled();
      expect(matching.find).not.toHaveBeenCalled();
      expect(carts.findActiveByCustomer).not.toHaveBeenCalled();
      expect(orders.create).not.toHaveBeenCalled();
    });

    it('rejects (IDEMPOTENCY_CONFLICT) when the same key was already used by a different customer', async () => {
      const { command, orders } = build();
      orders.findByIdempotencyKey.mockResolvedValue(orderSnapshot({ customerUserId: 'someone-else' }));

      await expect(command.execute(input())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('resolves a concurrent-race unique-constraint collision as a replay for the same customer', async () => {
      const { command, orders, inventory } = build();
      orders.create.mockRejectedValue(Object.assign(new Error('unique violation'), { code: 'P2002' }));
      orders.findByIdempotencyKey
        .mockResolvedValueOnce(null) // pre-check: nothing yet
        .mockResolvedValueOnce(orderSnapshot({ status: 'PAID' })); // post-P2002: the winner

      const result = await command.execute(input());

      expect(result.replay).toBe(true);
      expect(inventory.release).toHaveBeenCalledWith({
        reservationId: 'reservation-1',
        reason: 'checkout-idempotency-replay',
      });
    });

    it('rejects (IDEMPOTENCY_CONFLICT) when a concurrent-race winner belongs to a different customer', async () => {
      const { command, orders } = build();
      orders.create.mockRejectedValue(Object.assign(new Error('unique violation'), { code: 'P2002' }));
      orders.findByIdempotencyKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(orderSnapshot({ customerUserId: 'someone-else' }));

      await expect(command.execute(input())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
  });

  /**
   * Coupons at checkout (ADR-019/020/021). The default cart is one line, `product-1` x2 at 500 =
   * a 1,000 subtotal; `config.get` returns `undefined` throughout, so the delivery fee and the
   * platform fee are both 0 and `grandTotal === subtotal - discountTotal`.
   *
   * What is *not* tested here is what a coupon is worth — `CouponValidator` owns that and has its
   * own 98-test spec. These tests are about the seam: that the right lines and the right pharmacy
   * reach Module 07, that the discount reaches the existing `PricingCalculator` call, and that a
   * failure after the order is committed does not leave a discounted order standing.
   */
  describe('coupons', () => {
    const validQuote = { valid: true as const, discountAmount: 150, code: 'SAVE10' };

    it('asks Module 07 nothing at all when no coupon code was supplied', async () => {
      const { command, coupons, orders } = build();

      await command.execute(input());

      expect(coupons.validate).not.toHaveBeenCalled();
      expect(coupons.apply).not.toHaveBeenCalled();
      expect(orders.create).toHaveBeenCalledWith(
        expect.objectContaining({ discountTotal: 0, grandTotal: 1000 }),
        expect.anything(),
        undefined,
      );
    });

    it('quotes against the repriced checkout lines and the matched pharmacy, never the cart', async () => {
      const { command, coupons } = build();
      coupons.validate.mockResolvedValue(validQuote as never);
      coupons.apply.mockResolvedValue({ discountAmount: 150 } as never);

      await command.execute(input({ couponCode: 'SAVE10' }));

      expect(coupons.validate).toHaveBeenCalledWith({
        customerUserId: 'customer-1',
        code: 'SAVE10',
        checkout: {
          // Module 05's chosen match — never anything the request supplied (ADR-020 clause 3).
          pharmacyId: 'pharmacy-1',
          // Step 4's fresh Module 03 price (500), not the cart's cached `indicativePrice`.
          lines: [{ catalogProductId: 'product-1', quantity: 2, unitPrice: 500 }],
        },
      });
    });

    it('feeds the quoted discount into the order totals through the existing pricing path', async () => {
      const { command, coupons, orders } = build();
      coupons.validate.mockResolvedValue(validQuote as never);
      coupons.apply.mockResolvedValue({ discountAmount: 150 } as never);

      await command.execute(input({ couponCode: 'SAVE10' }));

      // 1000 subtotal - 150 discount. `PricingCalculator` is unchanged and still the only thing
      // that computes this; the saga only hands it one more already-resolved input.
      expect(orders.create).toHaveBeenCalledWith(
        expect.objectContaining({ subtotal: 1000, discountTotal: 150, grandTotal: 850 }),
        expect.anything(),
        undefined,
      );
      expect(orders.createInvoice).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({
          totals: expect.objectContaining({ discountTotal: 150, grandTotal: 850 }),
        }),
        undefined,
      );
    });

    it('redeems against the created order once, after the transaction commits', async () => {
      const { command, coupons } = build();
      coupons.validate.mockResolvedValue(validQuote as never);
      coupons.apply.mockResolvedValue({ discountAmount: 150 } as never);

      await command.execute(input({ couponCode: 'SAVE10' }));

      // The order id could not have existed at quote time — which is exactly why quoting and
      // redeeming are two steps (§11.7).
      expect(coupons.apply).toHaveBeenCalledTimes(1);
      expect(coupons.apply).toHaveBeenCalledWith({
        code: 'SAVE10',
        orderId: 'order-1',
        customerUserId: 'customer-1',
        actorUserId: 'customer-1',
      });
    });

    it('refuses the checkout when the coupon does not apply, before anything is created', async () => {
      const { command, coupons, orders, inventory } = build();
      coupons.validate.mockResolvedValue({
        valid: false,
        reason: 'NOT_IN_SCOPE',
        discountAmount: 0,
      } as never);

      await expect(command.execute(input({ couponCode: 'SAVE10' }))).rejects.toMatchObject({
        code: ErrorCode.COUPON_INVALID,
      });

      // The customer asked for this coupon; placing the order at full price without it would
      // charge them more than they intended. Raised before the order and before confirmation, so
      // the saga's existing reservation handling covers it.
      expect(orders.create).not.toHaveBeenCalled();
      expect(inventory.confirm).not.toHaveBeenCalled();
      expect(coupons.apply).not.toHaveBeenCalled();
    });

    it('maps an expired coupon onto COUPON_EXPIRED and a usage limit onto COUPON_USAGE_EXCEEDED', async () => {
      for (const [reason, code] of [
        ['EXPIRED', ErrorCode.COUPON_EXPIRED],
        ['GLOBAL_LIMIT_REACHED', ErrorCode.COUPON_USAGE_EXCEEDED],
        ['PER_USER_LIMIT_REACHED', ErrorCode.COUPON_USAGE_EXCEEDED],
        ['NOT_FOUND', ErrorCode.COUPON_INVALID],
      ] as const) {
        const { command, coupons } = build();
        coupons.validate.mockResolvedValue({ valid: false, reason, discountAmount: 0 } as never);

        // Module 07's existing §12 vocabulary, reused rather than redefined — a client sees the
        // same coupon errors here as it would from `POST /coupons/validate`.
        await expect(command.execute(input({ couponCode: 'SAVE10' }))).rejects.toMatchObject({
          code,
        });
      }
    });

    it('cancels the order and releases its stock when the redemption fails after commit', async () => {
      const { command, coupons, orders, inventory } = build();
      coupons.validate.mockResolvedValue(validQuote as never);
      // The realistic case: a concurrent checkout took the coupon's last global usage between the
      // quote and the redemption, or ADR-021 refused it.
      coupons.apply.mockRejectedValue(
        new ApiException(ErrorCode.COUPON_USAGE_EXCEEDED, 'No usages left.'),
      );

      await expect(command.execute(input({ couponCode: 'SAVE10' }))).rejects.toMatchObject({
        code: ErrorCode.COUPON_USAGE_EXCEEDED,
      });

      // ADR-014 makes the window structural — the two transactions cannot commit together — so it
      // is compensated rather than prevented. No discounted order is left standing, and the
      // coupon, never redeemed, is still the customer's to spend.
      expect(orders.updateStatus).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({
          status: 'CANCELLED',
          cancelReason: 'checkout-coupon-redemption-failed',
        }),
        expect.objectContaining({ toStatus: 'CANCELLED', actorRole: 'SYSTEM' }),
        undefined,
      );
      expect(inventory.release).toHaveBeenCalledWith({
        reservationId: 'reservation-1',
        reason: 'checkout-coupon-redemption-failed',
      });
    });

    it('refuses when the redemption prices differently than the order was created at', async () => {
      const { command, coupons, orders } = build();
      coupons.validate.mockResolvedValue(validQuote as never);
      // Module 07 re-scores the committed `order_lines`, so this should be impossible. It is a
      // defect tripwire: an order committed at a total its own redemption disagrees with must not
      // be allowed to stand quietly.
      coupons.apply.mockResolvedValue({ discountAmount: 99 } as never);

      await expect(command.execute(input({ couponCode: 'SAVE10' }))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });
      expect(orders.updateStatus).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({ status: 'CANCELLED' }),
        expect.anything(),
        undefined,
      );
    });

    it('does not re-quote or re-redeem on an idempotent replay', async () => {
      const { command, coupons, orders } = build();
      orders.findByIdempotencyKey.mockResolvedValueOnce(
        orderSnapshot({ id: 'order-1', customerUserId: 'customer-1' }),
      );

      const result = await command.execute(input({ couponCode: 'SAVE10' }));

      // The original attempt already consumed the usage. Quoting again would be harmless, but
      // redeeming again must not happen — and the replay branch returns before either.
      expect(result.replay).toBe(true);
      expect(coupons.validate).not.toHaveBeenCalled();
      expect(coupons.apply).not.toHaveBeenCalled();
    });
  });
});

describe('CheckoutCommand — the delivery fee that is actually charged (F-FEE-01, BR-DEL-09)', () => {
  it('charges the fee Module 08 calculated, and freezes it on the order', async () => {
    const { command, orders, deliveryPricing } = build();
    deliveryPricing.quote.mockResolvedValue(deliveryQuote(4_250));

    await command.execute(input());

    expect(orders.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ deliveryFee: 4_250, grandTotal: 1_000 + 4_250 }),
    );
  });

  /**
   * §6's boundary, and the reason there is no quote token anywhere in this contract: a customer who
   * saw a cheaper number an hour ago cannot send it back, because there is no field to send it in.
   */
  it('has no input through which a client could supply a delivery fee', async () => {
    const { command, orders, deliveryPricing } = build();
    deliveryPricing.quote.mockResolvedValue(deliveryQuote(4_250));

    await command.execute(input({ deliveryFee: 0, distanceMeters: 1 }));

    expect(orders.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ deliveryFee: 4_250 }),
    );
  });

  it('prices against the branch matching actually chose, by id', async () => {
    const { command, deliveryPricing } = build();

    await command.execute(input());

    expect(deliveryPricing.quote).toHaveBeenCalledWith({
      customerUserId: 'customer-1',
      addressId: 'address-1',
      branchId: 'branch-1',
    });
  });

  it('leaves PricingCalculator the sole author of the total', async () => {
    const { command, orders, deliveryPricing } = build();
    deliveryPricing.quote.mockResolvedValue(deliveryQuote(300));

    await command.execute(input());

    const created = orders.create.mock.calls[0][0] as unknown as Record<string, number>;
    expect(created.grandTotal).toBe(
      created.subtotal + created.deliveryFee + created.platformFee - created.discountTotal,
    );
  });

  /**
   * §10: a routing failure must not become a fabricated price. It fails the checkout instead, and
   * the reservations taken a step earlier are released by the existing compensation.
   */
  it('creates no order when the delivery quote is unavailable', async () => {
    const { command, orders, carts, inventory, deliveryPricing } = build();
    deliveryPricing.quote.mockRejectedValue(new Error('routing provider unreachable'));

    await expect(command.execute(input())).rejects.toThrow();

    expect(orders.create).not.toHaveBeenCalled();
    expect(carts.markConverted).not.toHaveBeenCalled();
    expect(inventory.release).toHaveBeenCalled();
  });

  it('asks Module 08 once per checkout, outside the transaction', async () => {
    const { command, deliveryPricing } = build();

    await command.execute(input());

    expect(deliveryPricing.quote).toHaveBeenCalledTimes(1);
  });
});
