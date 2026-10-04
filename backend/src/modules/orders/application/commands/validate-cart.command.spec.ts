import { IConfigPort } from '../../../../shared/config/config.port';
import { GetAvailabilityQuery } from '../../../pharmacy-inventory/application/queries/get-availability.query';
import {
  CartItemSnapshot,
  CartSnapshot,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import { ICatalogPort } from '../ports/outbound/catalog.port';
import { ValidateCartCommand } from './validate-cart.command';

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
  const config = {
    get: jest.fn((key: string) => (key === 'orders.deliveryFeeFlat' ? 100 : 0)),
  } as unknown as jest.Mocked<IConfigPort>;
  const availability = {
    execute: jest.fn().mockResolvedValue([{ sellable: 50 }]),
  } as unknown as jest.Mocked<GetAvailabilityQuery>;

  const command = new ValidateCartCommand(carts, catalog, config, availability);
  return { command, carts, catalog, availability };
}

describe('ValidateCartCommand (spec 9.1 — POST /cart/validate)', () => {
  it('reports an empty cart as not ready, with no items and no totals', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot({ items: [] }));

    await expect(command.execute({ customerUserId: 'customer-1' })).resolves.toMatchObject({
      items: [],
      totals: null,
      readyForCheckout: false,
    });
  });

  it('reports a customer with no cart at all as not ready', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(null);

    await expect(command.execute({ customerUserId: 'customer-1' })).resolves.toMatchObject({
      cartId: null,
      readyForCheckout: false,
    });
  });

  it('scopes the lookup to the authenticated customer, never a client-supplied cart id', async () => {
    const { command, carts } = build();

    await command.execute({ customerUserId: 'customer-1' });

    expect(carts.findActiveByCustomer).toHaveBeenCalledWith('customer-1');
    expect(carts.findById).not.toHaveBeenCalled();
  });

  it('flags priceChanged = false and leaves the cache alone when the price is unchanged', async () => {
    const { command, carts } = build();

    const result = await command.execute({ customerUserId: 'customer-1' });

    expect(result.items[0].priceChanged).toBe(false);
    expect(result.items[0].unitPrice).toBe(2500);
    expect(carts.reconcileItemPrice).not.toHaveBeenCalled();
  });

  it('flags priceChanged = true against the current catalog price and reconciles the cache', async () => {
    const { command, carts, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ price: 3100 }));

    const result = await command.execute({ customerUserId: 'customer-1' });

    // Reported against the stale cached price...
    expect(result.items[0]).toMatchObject({
      priceChanged: true,
      previousPrice: 2500,
      unitPrice: 3100,
      lineTotal: 6200,
    });
    // ...and only then reconciled, so the customer is told before the baseline moves (F-CRT-06).
    expect(carts.reconcileItemPrice).toHaveBeenCalledWith('item-1', 3100, false);
  });

  it('computes authoritative totals from the fresh catalog price, not the cached one', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ price: 3100 }));

    const result = await command.execute({ customerUserId: 'customer-1' });

    expect(result.totals?.subtotal).toBe(6200); // 3100 x 2, not the cached 2500 x 2
    expect(result.totals?.grandTotal).toBe(6300); // + 100 flat delivery fee
  });

  it('marks stillAvailable = true when a pharmacy can cover the line quantity', async () => {
    const { command } = build();

    const result = await command.execute({ customerUserId: 'customer-1' });

    expect(result.items[0].stillAvailable).toBe(true);
    expect(result.readyForCheckout).toBe(true);
  });

  it('marks stillAvailable = false when no listing covers the quantity, blocking checkout', async () => {
    const { command, availability } = build();
    (availability.execute as jest.Mock).mockResolvedValue([{ sellable: 1 }]);

    const result = await command.execute({ customerUserId: 'customer-1' });

    expect(result.items[0].stillAvailable).toBe(false);
    expect(result.readyForCheckout).toBe(false);
  });

  it('marks an unpriced/withdrawn product unavailable rather than pricing it at zero', async () => {
    const { command, catalog, carts } = build();
    catalog.getProduct.mockResolvedValue(null);

    const result = await command.execute({ customerUserId: 'customer-1' });

    expect(result.items[0]).toMatchObject({ unitPrice: null, stillAvailable: false });
    expect(result.totals).toBeNull();
    expect(result.readyForCheckout).toBe(false);
    expect(carts.reconcileItemPrice).not.toHaveBeenCalled();
  });

  it('refreshes the cached Rx flag from Catalog (spec 9.1 "flag Rx items")', async () => {
    const { command, carts, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ rxClassification: 'RX' }));

    const result = await command.execute({ customerUserId: 'customer-1' });

    expect(result.items[0].requiresRx).toBe(true);
    expect(carts.reconcileItemPrice).toHaveBeenCalledWith('item-1', 2500, true);
  });

  it('never mutates cart contents - no add, quantity change, removal, clear or conversion', async () => {
    const { command, carts, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ price: 3100 }));

    await command.execute({ customerUserId: 'customer-1' });

    expect(carts.addItem).not.toHaveBeenCalled();
    expect(carts.updateItemQuantity).not.toHaveBeenCalled();
    expect(carts.removeItem).not.toHaveBeenCalled();
    expect(carts.clearItems).not.toHaveBeenCalled();
    expect(carts.markConverted).not.toHaveBeenCalled();
    expect(carts.create).not.toHaveBeenCalled();
  });
});
