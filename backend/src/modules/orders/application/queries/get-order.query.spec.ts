import { IOrderRepository } from '../../domain/repositories/order.repository';
import { orderLineSnapshot, orderSnapshot } from '../commands/test-fixtures';
import { GetOrderQuery } from './get-order.query';

function build() {
  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn(),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    listByCustomer: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    findStatusHistory: jest.fn().mockResolvedValue([]),
    createLines: jest.fn(),
    findLinesByOrderId: jest.fn().mockResolvedValue([orderLineSnapshot()]),
    updateLineFulfillment: jest.fn(),
    createInvoice: jest.fn(),
    findInvoiceByOrderId: jest.fn(),
  };
  const query = new GetOrderQuery(orders);
  return { query, orders };
}

describe('GetOrderQuery', () => {
  it('returns the order with its lines and status history for the owning customer', async () => {
    const { query, orders } = build();
    orders.findById.mockResolvedValue(orderSnapshot());

    const result = await query.execute({ orderId: 'order-1', customerUserId: 'customer-1' });

    expect(result.order.id).toBe('order-1');
    expect(result.lines).toHaveLength(1);
    expect(orders.findStatusHistory).toHaveBeenCalledWith('order-1');
  });

  it('404s (ORDER_NOT_FOUND) when the order does not exist', async () => {
    const { query, orders } = build();
    orders.findById.mockResolvedValue(null);

    await expect(
      query.execute({ orderId: 'missing', customerUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('404s (ORDER_NOT_FOUND, no existence leakage) when the order belongs to another customer', async () => {
    const { query, orders } = build();
    orders.findById.mockResolvedValue(orderSnapshot({ customerUserId: 'someone-else' }));

    await expect(
      query.execute({ orderId: 'order-1', customerUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });
});
