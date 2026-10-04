import { IOrderRepository } from '../../domain/repositories/order.repository';
import { orderSnapshot } from '../commands/test-fixtures';
import { ListOrdersQuery } from './list-orders.query';

function build() {
  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn(),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    listByCustomer: jest.fn().mockResolvedValue({ items: [orderSnapshot()], total: 1 }),
    create: jest.fn(),
    updateStatus: jest.fn(),
    findStatusHistory: jest.fn(),
    createLines: jest.fn(),
    findLinesByOrderId: jest.fn(),
    updateLineFulfillment: jest.fn(),
    createInvoice: jest.fn(),
    findInvoiceByOrderId: jest.fn(),
  };
  const query = new ListOrdersQuery(orders);
  return { query, orders };
}

describe('ListOrdersQuery', () => {
  it('delegates straight to IOrderRepository.listByCustomer with the caller-scoped criteria', async () => {
    const { query, orders } = build();

    const result = await query.execute({ customerUserId: 'customer-1', page: 1, size: 20 });

    expect(orders.listByCustomer).toHaveBeenCalledWith({
      customerUserId: 'customer-1',
      page: 1,
      size: 20,
    });
    expect(result.total).toBe(1);
  });

  it('passes an optional status filter through unchanged', async () => {
    const { query, orders } = build();

    await query.execute({ customerUserId: 'customer-1', status: 'PAID', page: 1, size: 20 });

    expect(orders.listByCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PAID' }),
    );
  });
});
