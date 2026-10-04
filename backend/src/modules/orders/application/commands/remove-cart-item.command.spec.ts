import { CartItemSnapshot, CartSnapshot, ICartRepository } from '../../domain/repositories/cart.repository';
import { RemoveCartItemCommand } from './remove-cart-item.command';

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

function build() {
  const carts: jest.Mocked<ICartRepository> = {
    findActiveByCustomer: jest.fn(),
    findById: jest.fn().mockResolvedValue(cartSnapshot()),
    create: jest.fn(),
    findItemById: jest.fn().mockResolvedValue(itemSnapshot()),
    addItem: jest.fn(),
    updateItemQuantity: jest.fn(),
    removeItem: jest.fn(),
    reconcileItemPrice: jest.fn(),
    clearItems: jest.fn(),
    markConverted: jest.fn(),
  };
  const command = new RemoveCartItemCommand(carts);
  return { command, carts };
}

describe('RemoveCartItemCommand', () => {
  it('removes an owned item', async () => {
    const { command, carts } = build();
    await command.execute({ customerUserId: 'customer-1', cartItemId: 'item-1' });
    expect(carts.removeItem).toHaveBeenCalledWith('item-1');
  });

  it('throws not-found when the item does not exist', async () => {
    const { command, carts } = build();
    carts.findItemById.mockResolvedValue(null);
    await expect(
      command.execute({ customerUserId: 'customer-1', cartItemId: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(carts.removeItem).not.toHaveBeenCalled();
  });

  it('throws not-found (never leaking existence) when the item belongs to another customer', async () => {
    const { command, carts } = build();
    carts.findById.mockResolvedValue(cartSnapshot({ customerUserId: 'someone-else' }));
    await expect(
      command.execute({ customerUserId: 'customer-1', cartItemId: 'item-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(carts.removeItem).not.toHaveBeenCalled();
  });
});
