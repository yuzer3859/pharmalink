import { IOrderRepository, InvoiceSnapshot } from '../../domain/repositories/order.repository';
import { orderSnapshot } from '../commands/test-fixtures';
import { GetOrderInvoiceQuery } from './get-order-invoice.query';

function invoiceSnapshot(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: 'invoice-1',
    orderId: 'order-1',
    invoiceNumber: 'INV-0001',
    pdfRef: null,
    totals: { grandTotal: 1150, currency: 'ETB' },
    issuedAt: new Date(),
    ...overrides,
  };
}

function build() {
  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn(),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    listByCustomer: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    findStatusHistory: jest.fn(),
    createLines: jest.fn(),
    findLinesByOrderId: jest.fn(),
    updateLineFulfillment: jest.fn(),
    createInvoice: jest.fn(),
    findInvoiceByOrderId: jest.fn().mockResolvedValue(invoiceSnapshot()),
  };
  const query = new GetOrderInvoiceQuery(orders);
  return { query, orders };
}

describe('GetOrderInvoiceQuery', () => {
  it('returns the invoice for the owning customer', async () => {
    const { query, orders } = build();
    orders.findById.mockResolvedValue(orderSnapshot());

    const result = await query.execute({ orderId: 'order-1', customerUserId: 'customer-1' });

    expect(result.invoiceNumber).toBe('INV-0001');
  });

  it('404s (ORDER_NOT_FOUND) when the order belongs to another customer', async () => {
    const { query, orders } = build();
    orders.findById.mockResolvedValue(orderSnapshot({ customerUserId: 'someone-else' }));

    await expect(
      query.execute({ orderId: 'order-1', customerUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('404s (NOT_FOUND) when the order has no invoice row', async () => {
    const { query, orders } = build();
    orders.findById.mockResolvedValue(orderSnapshot());
    orders.findInvoiceByOrderId.mockResolvedValue(null);

    await expect(
      query.execute({ orderId: 'order-1', customerUserId: 'customer-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
