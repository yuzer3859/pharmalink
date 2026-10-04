import { CartItemSnapshot, CartSnapshot, ICartRepository } from '../../domain/repositories/cart.repository';
import { CatalogProductView, ICatalogPort } from '../ports/outbound/catalog.port';
import { AddCartItemCommand } from './add-cart-item.command';

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

function itemSnapshot(overrides: Partial<CartItemSnapshot> = {}): CartItemSnapshot {
  return {
    id: 'item-1',
    cartId: 'cart-1',
    catalogProductId: 'product-1',
    quantity: 2,
    indicativePrice: 1000,
    requiresRx: false,
    addedAt: new Date(),
    ...overrides,
  };
}

function product(overrides: Partial<CatalogProductView> = {}): CatalogProductView {
  return {
    id: 'product-1',
    status: 'ACTIVE',
    rxClassification: null,
    price: 1000,
    name: 'Paracetamol 500mg',
    ...overrides,
  };
}

function build() {
  const carts: jest.Mocked<ICartRepository> = {
    findActiveByCustomer: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    findItemById: jest.fn(),
    addItem: jest.fn().mockResolvedValue(itemSnapshot()),
    updateItemQuantity: jest.fn(),
    removeItem: jest.fn(),
    reconcileItemPrice: jest.fn(),
    clearItems: jest.fn(),
    markConverted: jest.fn(),
  };
  const catalog: jest.Mocked<ICatalogPort> = {
    getProduct: jest.fn().mockResolvedValue(product()),
  };
  const command = new AddCartItemCommand(carts, catalog);
  return { command, carts, catalog };
}

describe('AddCartItemCommand', () => {
  it('creates a new ACTIVE cart lazily on the customer\'s first item (§3.1)', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(null);
    carts.create.mockResolvedValue(cartSnapshot());

    await command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 2 });

    expect(carts.create).toHaveBeenCalledWith('customer-1');
    expect(carts.addItem).toHaveBeenCalledWith('cart-1', {
      catalogProductId: 'product-1',
      quantity: 2,
      indicativePrice: 1000,
      requiresRx: false,
    });
  });

  it('reuses the existing ACTIVE cart without creating a second one', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot());

    await command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1 });

    expect(carts.create).not.toHaveBeenCalled();
  });

  it('caches requiresRx from a fresh ICatalogPort read (§3.2)', async () => {
    const { command, carts, catalog } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot());
    catalog.getProduct.mockResolvedValue(product({ rxClassification: 'RX' }));

    await command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1 });

    expect(carts.addItem).toHaveBeenCalledWith(
      'cart-1',
      expect.objectContaining({ requiresRx: true }),
    );
  });

  it('caches requiresRx=false for an OTC medicine', async () => {
    // Regression: `Boolean(rxClassification)` cached requiresRx=true for the string 'OTC'.
    const { command, carts, catalog } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot());
    catalog.getProduct.mockResolvedValue(product({ rxClassification: 'OTC' }));

    await command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1 });

    expect(carts.addItem).toHaveBeenCalledWith(
      'cart-1',
      expect.objectContaining({ requiresRx: false }),
    );
  });

  it('rejects a zero/negative/non-integer quantity (domain Quantity)', async () => {
    const { command } = build();
    await expect(
      command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1.5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a missing catalog product', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue(null);

    await expect(
      command.execute({ customerUserId: 'customer-1', catalogProductId: 'unknown', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'CATALOG_PRODUCT_NOT_FOUND' });
  });

  it('rejects a non-ACTIVE catalog product', async () => {
    const { command, catalog } = build();
    catalog.getProduct.mockResolvedValue(product({ status: 'DELETED' }));

    await expect(
      command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'CATALOG_PRODUCT_NOT_FOUND' });
  });

  it('rejects adding a product already in the cart (CartPolicy.assertUniqueProduct)', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(
      cartSnapshot({ items: [itemSnapshot({ catalogProductId: 'product-1' })] }),
    );

    await expect(
      command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(carts.addItem).not.toHaveBeenCalled();
  });

  it('allows adding a different product alongside an existing one', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(
      cartSnapshot({ items: [itemSnapshot({ catalogProductId: 'product-other' })] }),
    );

    await command.execute({ customerUserId: 'customer-1', catalogProductId: 'product-1', quantity: 1 });
    expect(carts.addItem).toHaveBeenCalledTimes(1);
  });
});
