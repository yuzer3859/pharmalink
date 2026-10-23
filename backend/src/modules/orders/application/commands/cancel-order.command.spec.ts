import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { CancellationOutcome, OrderCancellationWorkflow } from '../services/order-cancellation.workflow';
import { CancelOrderCommand } from './cancel-order.command';
import { orderLineSnapshot, orderSnapshot } from './test-fixtures';

/**
 * The request path only (Work 55): ownership, the status policies, the read-only dispatch pre-check,
 * and how a workflow outcome becomes the response. The saga itself is covered by
 * `order-cancellation.workflow.spec.ts` and the e2e suites.
 */
function build(outcome: CancellationOutcome = 'COMPLETED', statusAfter = 'CANCELLED') {
  const order = orderSnapshot({ status: 'PAID' });
  const orders = {
    findById: jest.fn().mockResolvedValueOnce(order).mockResolvedValue({ ...order, status: statusAfter }),
    findLinesByOrderId: jest.fn().mockResolvedValue([
      orderLineSnapshot({ id: 'l1', reservationId: 'reservation-1' }),
      orderLineSnapshot({ id: 'l2', reservationId: 'reservation-2' }),
      orderLineSnapshot({ id: 'l3', reservationId: 'reservation-1' }),
      orderLineSnapshot({ id: 'l4', reservationId: null }),
    ]),
  } as unknown as jest.Mocked<IOrderRepository>;
  const inventory = {
    getReservationFulfillment: jest.fn(async (reservationId: string) => ({ reservationId, status: 'CONFIRMED', dispatched: false, dispatchedQuantity: 0 })),
  } as unknown as jest.Mocked<IInventoryPort>;
  const workflow = { start: jest.fn().mockResolvedValue(outcome) } as unknown as jest.Mocked<OrderCancellationWorkflow>;
  return { command: new CancelOrderCommand(orders, inventory, workflow), orders, inventory, workflow, order };
}

const input = (overrides: Record<string, unknown> = {}) => ({ orderId: 'order-1', customerUserId: 'customer-1', reason: 'Changed my mind', ...overrides });

describe('CancelOrderCommand', () => {
  it('starts the workflow with the original customer and reason, and returns the CANCELLED order', async () => {
    const { command, workflow } = build();
    const result = await command.execute(input());
    expect(workflow.start).toHaveBeenCalledWith({ orderId: 'order-1', customerUserId: 'customer-1', reason: 'Changed my mind' });
    expect(result.status).toBe('CANCELLED');
  });

  it('returns the order (200) when it is CANCELLED even though the coupon reversal is still pending', async () => {
    const { command } = build('ORDER_CANCELLED');
    expect((await command.execute(input())).status).toBe('CANCELLED');
  });

  it('404s (ORDER_NOT_FOUND) for a missing order or another customer’s, before anything else', async () => {
    const missing = build();
    missing.orders.findById.mockReset().mockResolvedValue(null);
    await expect(missing.command.execute(input())).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    const other = build();
    await expect(other.command.execute(input({ customerUserId: 'someone-else' }))).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    expect(other.workflow.start).not.toHaveBeenCalled();
  });

  it('422s (CANCELLATION_NOT_ALLOWED) once the order has reached READY — no pre-check, no workflow', async () => {
    const { command, orders, inventory, workflow, order } = build();
    orders.findById.mockReset().mockResolvedValue({ ...order, status: 'READY' });
    await expect(command.execute(input())).rejects.toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED' });
    expect(inventory.getReservationFulfillment).not.toHaveBeenCalled();
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('pre-check: a dispatched reservation answers 422 without persisting anything (each reservation read once)', async () => {
    const { command, inventory, workflow } = build();
    inventory.getReservationFulfillment.mockImplementation(async (id: string) => ({ reservationId: id, status: 'CONFIRMED', dispatched: id === 'reservation-2', dispatchedQuantity: 0 }));
    await expect(command.execute(input())).rejects.toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED', httpStatus: 422 });
    expect(inventory.getReservationFulfillment.mock.calls.map((c) => c[0]).sort()).toEqual(['reservation-1', 'reservation-2']);
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('pre-check is not a safeguard: a read failure defers to the workflow', async () => {
    const { command, inventory, workflow } = build();
    inventory.getReservationFulfillment.mockRejectedValue(new Error('read failed'));
    await command.execute(input());
    expect(workflow.start).toHaveBeenCalledTimes(1);
  });

  it('a REJECTED workflow (dispatch won the race) is 422 CANCELLATION_NOT_ALLOWED', async () => {
    const { command } = build('REJECTED', 'ACCEPTED');
    await expect(command.execute(input())).rejects.toMatchObject({ code: 'CANCELLATION_NOT_ALLOWED', httpStatus: 422 });
  });

  it('an unfinished workflow before the order is cancelled is 503 cancellation PENDING (it completes automatically)', async () => {
    for (const outcome of ['PENDING', 'BUSY'] as const) {
      const { command } = build(outcome, 'PAID');
      await expect(command.execute(input())).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', httpStatus: 503, details: { cancellation: 'PENDING' } });
    }
  });

  it('a permanent failure before the order is cancelled is 409 NEEDS_ATTENTION — never reported as cancelled', async () => {
    const { command } = build('ATTENTION', 'PAID');
    await expect(command.execute(input())).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409, details: { cancellation: 'NEEDS_ATTENTION' } });
  });
});
