import { CartSnapshot, ICartRepository } from '../../domain/repositories/cart.repository';
import { ClearCartCommand } from './clear-cart.command';

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
  const command = new ClearCartCommand(carts);
  return { command, carts };
}

describe('ClearCartCommand', () => {
  it('clears every item on the customer\'s ACTIVE cart', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(cartSnapshot());

    await command.execute({ customerUserId: 'customer-1' });

    expect(carts.clearItems).toHaveBeenCalledWith('cart-1');
  });

  it('is a no-op when the customer has no ACTIVE cart (DELETE idempotency)', async () => {
    const { command, carts } = build();
    carts.findActiveByCustomer.mockResolvedValue(null);

    await expect(command.execute({ customerUserId: 'customer-1' })).resolves.toBeUndefined();
    expect(carts.clearItems).not.toHaveBeenCalled();
  });
});
