import {
  DeliveryPricingQuote,
  IDeliveryPricingPort,
} from '../../../delivery/application/ports/inbound/delivery-pricing.port';
import { IConfigPort } from '../../../../shared/config/config.port';
import { ICheckRxGatePort } from '../../../prescription-matching/application/ports/inbound/check-rx-gate.port';
import { IMatchingPort } from '../../../prescription-matching/application/ports/inbound/matching.port';
import {
  CartItemSnapshot,
  CartSnapshot,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import { IAddressPort } from '../ports/outbound/address.port';
import { ICatalogPort } from '../ports/outbound/catalog.port';
import { QuoteCheckoutCommand } from './quote-checkout.command';

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

function cartItem(overrides: Partial<CartItemSnapshot> = {}): CartItemSnapshot {
  return {
    id: 'item-1',
    cartId: 'cart-1',
    catalogProductId: 'product-1',
    quantity: 2,
    indicativePrice: 2500,
    requiresRx: false,
    addedAt: new Date(),
    ...overrides,
  };
}

function cartSnapshot(overrides: Partial<CartSnapshot> = {}): CartSnapshot {
  return {
    id: 'cart-1',
    customerUserId: 'customer-1',
    beneficiaryId: null,
    status: 'ACTIVE',
    items: [cartItem()],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    status: 'ACTIVE',
    rxClassification: null,
    price: 2500,
    name: 'Ibuprofen 400mg',
    ...overrides,
  };
}

function build() {
  const carts: jest.Mocked<ICartRepository> = {
    findActiveByCustomer: jest.fn().mockResolvedValue(cartSnapshot()),
    findById: jest.fn(),
    create: jest.fn(),
    findItemById: jest.fn(),
    addItem: jest.fn(),
    updateItemQuantity: jest.fn(),
    removeItem: jest.fn(),
    reconcileItemPrice: jest.fn(),
    clearItems: jest.fn(),
    markConverted: jest.fn(),
  };
  const catalog: jest.Mocked<ICatalogPort> = {
    getProduct: jest.fn().mockResolvedValue(product()),
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
    check: jest.fn().mockResolvedValue({
      allowed: true,
      blocked: [],
      usablePrescriptionLineIds: ['rx-line-1'],
    }),
  };
  const matching: jest.Mocked<IMatchingPort> = {
    find: jest.fn().mockResolvedValue({
      matchRequest: { id: 'match-1' },
      candidates: [
        {
          id: 'cand-1',
          matchRequestId: 'match-1',
          pharmacyId: 'pharmacy-1',
          branchId: 'branch-1',
          coverage: 'FULL',
          totalPrice: 5000,
          distanceMeters: 1200,
          rating: null,
          rank: 1,
          createdAt: new Date(),
        },
      ],
    }),
    select: jest.fn(),
    rematch: jest.fn(),
  };
  /**
   * Every key resolves to `0`, `orders.deliveryFeeFlat` included.
   *
   * That key used to supply the delivery fee and no longer does — Module 08 does, through
   * `DELIVERY_PRICING_PORT`. Leaving it wired to zero here is deliberate: the existing
   * `grandTotal === 5100` expectation below now passes **only** if the 100 came from the pricing
   * port, so the test proves the new boundary rather than merely tolerating it.
   */
  const config = {
    get: jest.fn(() => 0),
  } as unknown as jest.Mocked<IConfigPort>;

  const deliveryPricing: jest.Mocked<IDeliveryPricingPort> = {
    quote: jest.fn().mockResolvedValue(deliveryQuote(100)),
  };

  const command = new QuoteCheckoutCommand(
    carts,
    catalog,
    addresses,
    checkRxGate,
    matching,
    deliveryPricing,
    config,
  );
  return { command, carts, catalog, addresses, checkRxGate, matching, deliveryPricing };
}

const input = () => ({ customerUserId: 'customer-1', addressId: 'address-1' });

describe('QuoteCheckoutCommand (spec 9.2 — POST /checkout/quote)', () => {
  it('returns rxGateResult, candidates and totals', async () => {
    const { command } = build();

    const result = await command.execute(input());

    expect(result.rxGateResult.allowed).toBe(true);
    expect(result.candidates).toEqual([
      {
        pharmacyId: 'pharmacy-1',
        branchId: 'branch-1',
        coverage: 'FULL',
        totalPrice: 5000,
        distanceMeters: 1200,
        rank: 1,
      },
    ]);
    expect(result.totals.subtotal).toBe(5000);
    expect(result.totals.grandTotal).toBe(5100);
  });

  it('prices totals from the fresh catalog read, not the cached indicativePrice', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ price: 3100 }));

    const result = await command.execute(input());

    expect(result.totals.subtotal).toBe(6200); // 3100 x 2, not the cached 2500 x 2
  });

  it('calls IMatchingPort.find and never IMatchingPort.select (a quote reserves nothing)', async () => {
    const { command, matching } = build();

    await command.execute(input());

    expect(matching.find).toHaveBeenCalledTimes(1);
    expect(matching.select).not.toHaveBeenCalled();
    expect(matching.rematch).not.toHaveBeenCalled();
  });

  it('passes the authenticated customer and the resolved address geo into matching', async () => {
    const { command, matching } = build();

    await command.execute(input());

    expect(matching.find).toHaveBeenCalledWith({
      customerUserId: 'customer-1',
      lines: [{ catalogProductId: 'product-1', quantity: 2 }],
      deliveryLat: 9.03,
      deliveryLng: 38.74,
    });
  });

  it('runs the Module 05 Rx gate for an Rx line and reports the result instead of throwing', async () => {
    const { command, checkRxGate, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ rxClassification: 'RX' }));
    checkRxGate.check.mockResolvedValue({
      allowed: false,
      blocked: [{ catalogProductId: 'product-1', reason: 'RX_REQUIRED' }] as never,
      usablePrescriptionLineIds: [],
    });

    const result = await command.execute(input());

    expect(checkRxGate.check).toHaveBeenCalledWith({
      customerUserId: 'customer-1',
      items: [{ catalogProductId: 'product-1', quantity: 2 }],
    });
    // Spec 9.2 contracts rxGateResult as part of a successful 200 so the client can see why it
    // is blocked before committing; only /checkout itself throws RX_REQUIRED.
    expect(result.rxGateResult.allowed).toBe(false);
  });

  it('skips the Rx gate entirely for an OTC-only cart', async () => {
    const { command, checkRxGate } = build();

    const result = await command.execute(input());

    expect(checkRxGate.check).not.toHaveBeenCalled();
    expect(result.rxGateResult).toEqual({
      allowed: true,
      blocked: [],
      usablePrescriptionLineIds: [],
    });
  });

  it('rejects an address the caller does not own', async () => {
    const { command, addresses, matching } = build();
    addresses.getAddress.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(addresses.getAddress).toHaveBeenCalledWith('address-1', 'customer-1');
    expect(matching.find).not.toHaveBeenCalled();
  });

  it('rejects an empty cart before touching Catalog or Module 05', async () => {
    const { command, carts, catalog, matching } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot({ items: [] }));

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(catalog.getProduct).not.toHaveBeenCalled();
    expect(matching.find).not.toHaveBeenCalled();
  });

  it('rejects an unpriced/withdrawn cart line rather than quoting a price checkout would refuse', async () => {
    const { command, catalog, matching } = build();
    catalog.getProduct.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'CATALOG_PRODUCT_NOT_FOUND',
    });
    expect(matching.find).not.toHaveBeenCalled();
  });

  it('propagates a matching failure unchanged', async () => {
    const { command, matching } = build();
    matching.find.mockRejectedValue(
      Object.assign(new Error('no match'), { code: 'NO_PHARMACY_MATCH' }),
    );

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'NO_PHARMACY_MATCH' });
  });

  it('confirms the quoted price as the cart baseline, after the quote is computed', async () => {
    const { command, carts, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ price: 3100 }));

    const result = await command.execute(input());

    expect(result.totals.subtotal).toBe(6200);
    expect(carts.reconcileItemPrice).toHaveBeenCalledWith('item-1', 3100, false);
  });

  it('leaves the baseline untouched when the quoted price already matches', async () => {
    const { command, carts } = build();

    await command.execute(input());

    expect(carts.reconcileItemPrice).not.toHaveBeenCalled();
  });

  it('creates nothing: no order, fulfillment, invoice, reservation or cart content change', async () => {
    const { command, carts, matching } = build();

    await command.execute(input());

    expect(matching.select).not.toHaveBeenCalled();
    expect(carts.markConverted).not.toHaveBeenCalled();
    expect(carts.addItem).not.toHaveBeenCalled();
    expect(carts.updateItemQuantity).not.toHaveBeenCalled();
    expect(carts.removeItem).not.toHaveBeenCalled();
    expect(carts.clearItems).not.toHaveBeenCalled();
  });
});

describe('QuoteCheckoutCommand — the Module 08 delivery-fee boundary (F-FEE-01)', () => {
  it('takes the delivery fee from the pricing port, not from a configuration key', async () => {
    const { command, deliveryPricing } = build();

    const result = await command.execute(input());

    expect(deliveryPricing.quote).toHaveBeenCalledTimes(1);
    expect(result.totals.deliveryFee).toBe(100);
  });

  it('prices against the top-ranked candidate, and names it by id rather than by coordinates', async () => {
    const { command, deliveryPricing } = build();

    await command.execute(input());

    expect(deliveryPricing.quote).toHaveBeenCalledWith({
      customerUserId: 'customer-1',
      addressId: 'address-1',
      branchId: 'branch-1',
    });
  });

  /**
   * `PricingCalculator` stays the sole author of the total. Module 08 contributes one input; every
   * other component, and the sum itself, is still Module 06's arithmetic.
   */
  it('leaves PricingCalculator authoritative over the total', async () => {
    const { command } = build();

    const result = await command.execute(input());

    expect(result.totals.subtotal).toBe(5000);
    expect(result.totals.deliveryFee).toBe(100);
    expect(result.totals.grandTotal).toBe(
      result.totals.subtotal +
        result.totals.deliveryFee +
        result.totals.platformFee -
        result.totals.discountTotal,
    );
  });

  it('quotes no delivery fee when no pharmacy can fulfil the cart', async () => {
    const { command, matching, deliveryPricing } = build();
    matching.find.mockResolvedValue({
      matchRequest: { id: 'match-1' },
      candidates: [],
    } as never);

    const result = await command.execute(input());

    expect(deliveryPricing.quote).not.toHaveBeenCalled();
    expect(result.totals.deliveryFee).toBe(0);
  });

  it('creates nothing when the delivery quote is unavailable', async () => {
    const { command, carts, deliveryPricing } = build();
    deliveryPricing.quote.mockRejectedValue(new Error('routing down'));

    await expect(
      command.execute(input()),
    ).rejects.toThrow();
    expect(carts.markConverted).not.toHaveBeenCalled();
  });
});
