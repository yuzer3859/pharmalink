import { IConfigPort } from '../../../../shared/config/config.port';
import {
  CartItemSnapshot,
  CartSnapshot,
  ICartRepository,
} from '../../domain/repositories/cart.repository';
import { ICatalogPort } from '../ports/outbound/catalog.port';
import { GetActiveCartQuery } from './get-active-cart.query';

function cartItem(overrides: Partial<CartItemSnapshot> = {}): CartItemSnapshot {
  return {
    id: 'item-1',
    cartId: 'cart-1',
    catalogProductId: 'product-1',
    quantity: 2,
    indicativePrice: 500,
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
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const carts: jest.Mocked<ICartRepository> = {
    findActiveByCustomer: jest.fn(),
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
    getProduct: jest.fn().mockResolvedValue({
      id: 'product-1',
      status: 'ACTIVE',
      rxClassification: null,
      price: 900,
      name: 'Paracetamol 500mg',
    }),
  };
  const config: jest.Mocked<IConfigPort> = {
    get: jest.fn((key: string) => (key === 'orders.deliveryFeeFlat' ? 100 : 0)),
  } as unknown as jest.Mocked<IConfigPort>;
  const query = new GetActiveCartQuery(carts, catalog, config);
  return { query, carts, catalog };
}

describe('GetActiveCartQuery', () => {
  it('returns the cart with live totals priced from the current catalog read (§9.1)', async () => {
    const { query, carts, catalog } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot({ items: [cartItem()] }));

    const result = await query.execute({ customerUserId: 'customer-1' });

    expect(carts.findActiveByCustomer).toHaveBeenCalledWith('customer-1');
    expect(catalog.getProduct).toHaveBeenCalledWith('product-1');
    // 900 x 2 from the fresh catalog read — never the cached indicativePrice of 500.
    expect(result?.totals?.subtotal).toBe(1800);
    expect(result?.totals?.grandTotal).toBe(1900); // + 100 flat delivery fee
    expect(result?.id).toBe('cart-1');
  });

  it('never prices totals from the stale cached indicativePrice', async () => {
    const { query, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(
      cartSnapshot({ items: [cartItem({ indicativePrice: 1 })] }),
    );

    const result = await query.execute({ customerUserId: 'customer-1' });

    expect(result?.totals?.subtotal).toBe(1800);
  });

  it('is a pure read — it never reconciles the cached price or creates a cart', async () => {
    const { query, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot({ items: [cartItem()] }));

    await query.execute({ customerUserId: 'customer-1' });

    expect(carts.reconcileItemPrice).not.toHaveBeenCalled();
    expect(carts.create).not.toHaveBeenCalled();
    expect(carts.addItem).not.toHaveBeenCalled();
  });

  it('returns null totals for an empty cart rather than a zero total', async () => {
    const { query, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot({ items: [] }));

    await expect(query.execute({ customerUserId: 'customer-1' })).resolves.toMatchObject({
      totals: null,
    });
  });

  it('returns null totals when a line is no longer priceable, rather than a partial total', async () => {
    const { query, carts, catalog } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot({ items: [cartItem()] }));
    catalog.getProduct.mockResolvedValue(null);

    await expect(query.execute({ customerUserId: 'customer-1' })).resolves.toMatchObject({
      totals: null,
    });
  });

  it('returns null when the customer has no ACTIVE cart yet (no auto-create on read)', async () => {
    const { query, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(null);

    await expect(query.execute({ customerUserId: 'customer-1' })).resolves.toBeNull();
    expect(carts.create).not.toHaveBeenCalled();
  });
});
