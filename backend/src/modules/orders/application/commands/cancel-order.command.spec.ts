import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { IInventoryPort } from '../../../pharmacy-inventory/application/ports/inbound/inventory.port';
import {
  ICouponPort,
} from '../../../payment/application/ports/inbound/coupon.port';
import { IOrderRepository } from '../../domain/repositories/order.repository';
import { IUnitOfWork } from '../ports/unit-of-work.port';
import { CancelOrderCommand } from './cancel-order.command';
import { orderLineSnapshot, orderSnapshot } from './test-fixtures';

function build() {
  const order = orderSnapshot({ status: 'PAID' });
  const orders: jest.Mocked<IOrderRepository> = {
    findById: jest.fn().mockResolvedValue(order),
    findByOrderNumber: jest.fn(),
    findByIdempotencyKey: jest.fn(),
    listByCustomer: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    findStatusHistory: jest.fn(),
    createLines: jest.fn(),
    findLinesByOrderId: jest.fn().mockResolvedValue([orderLineSnapshot({ reservationId: 'reservation-1' })]),
    updateLineFulfillment: jest.fn(),
    createInvoice: jest.fn(),
    findInvoiceByOrderId: jest.fn(),
  };
  const inventory: jest.Mocked<IInventoryPort> = {
    reserve: jest.fn(),
    confirm: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    dispatch: jest.fn(),
    getReservationFulfillment: jest.fn(),
  };
  const uow: IUnitOfWork = { run: (work) => work(undefined) };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'a', hash: 'h' }) } as unknown as AuditService;
  const outbox = { write: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxService;

  /** Module 07's coupon seam. Defaults to "this order had no coupon" — `reverse` rejects with
   * NOT_FOUND, which the command swallows, so pre-existing cancellation behaviour is unchanged. */
  const coupons: jest.Mocked<ICouponPort> = {
    validate: jest.fn(),
    apply: jest.fn(),
    reverse: jest.fn().mockRejectedValue(new Error('no redemption')),
  };

  const command = new CancelOrderCommand(orders, inventory, coupons, uow, audit, outbox);
  return { command, orders, inventory, coupons, audit, outbox, order };
}

function input(overrides: Record<string, unknown> = {}) {
  return { orderId: 'order-1', customerUserId: 'customer-1', reason: 'Changed my mind', ...overrides };
}

describe('CancelOrderCommand', () => {
  it('cancels a cancellable order, releases its reservations, and writes audit/outbox', async () => {
    const { command, orders, inventory, audit, outbox } = build();

    await command.execute(input());

    expect(inventory.release).toHaveBeenCalledWith({
      reservationId: 'reservation-1',
      reason: 'customer-cancel',
    });
    expect(orders.updateStatus).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ status: 'CANCELLED', cancelReason: 'Changed my mind' }),
      expect.objectContaining({ toStatus: 'CANCELLED' }),
      undefined,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ORDER_CANCELLED' }),
      undefined,
    );
    expect(outbox.write).toHaveBeenCalledTimes(1);
  });

  it('404s (ORDER_NOT_FOUND) when the order does not exist', async () => {
    const { command, orders } = build();
    orders.findById.mockResolvedValue(null);

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('404s (ORDER_NOT_FOUND, no existence leakage) when the order belongs to another customer', async () => {
    const { command, orders, order } = build();
    orders.findById.mockResolvedValue({ ...order, customerUserId: 'someone-else' });

    await expect(command.execute(input())).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('422s (CANCELLATION_NOT_ALLOWED) once the order has reached READY', async () => {
    const { command, orders, order } = build();
    orders.findById.mockResolvedValue({ ...order, status: 'READY' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'CANCELLATION_NOT_ALLOWED',
    });
  });

  it('re-validates cancellation eligibility against the fresh in-transaction read (race defense)', async () => {
    const { command, orders, order } = build();
    orders.findById
      .mockResolvedValueOnce({ ...order, status: 'PAID' })
      .mockResolvedValueOnce({ ...order, status: 'READY' });

    await expect(command.execute(input())).rejects.toMatchObject({
      code: 'CANCELLATION_NOT_ALLOWED',
    });
  });

  it('does not fail the cancellation if a reservation release fails (self-heals via TTL sweeper)', async () => {
    const { command, inventory, orders } = build();
    inventory.release.mockRejectedValue(new Error('Module 04 unavailable'));

    await command.execute(input());

    expect(orders.updateStatus).toHaveBeenCalled();
  });

  describe('coupon reversal (F-CPN-03)', () => {
    it('gives the coupon usage back for the cancelled order, without moving money', async () => {
      const { command, coupons } = build();
      coupons.reverse.mockResolvedValue({ status: 'REVERSED', replay: false } as never);

      await command.execute(input());

      // Identified by order id alone — Module 06 does not store which promotion was used, and
      // ADR-021 makes "this order's applied coupon" unambiguous. No code from the request could
      // aim the reversal at a different coupon.
      expect(coupons.reverse).toHaveBeenCalledWith({
        orderId: 'order-1',
        actorUserId: 'customer-1',
        reason: 'order-cancelled',
      });
      // Reversing usage is not a refund: no payment, ledger or money call is made from here.
      expect(coupons.apply).not.toHaveBeenCalled();
      expect(coupons.validate).not.toHaveBeenCalled();
    });

    it('still cancels the order when the reversal fails', async () => {
      const { command, orders, coupons } = build();
      coupons.reverse.mockRejectedValue(new Error('coupon service unavailable'));

      await command.execute(input());

      // Best-effort, exactly like the reservation release above (ADR-014): a customer entitled to
      // cancel must not be blocked by Module 07 being unavailable. The cost is one usage that is
      // not immediately re-spendable, recoverable from the redemption record.
      expect(orders.updateStatus).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({ status: 'CANCELLED' }),
        expect.objectContaining({ toStatus: 'CANCELLED' }),
        undefined,
      );
    });

    it('cancels normally for an order that never had a coupon', async () => {
      const { command, orders, coupons } = build();
      // Module 07 answers NOT_FOUND when there is no redemption; that is not an error worth
      // distinguishing here, because there is nothing to reverse either way.
      coupons.reverse.mockRejectedValue(new Error('No coupon redemption found for this order.'));

      await command.execute(input());

      expect(orders.updateStatus).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({ status: 'CANCELLED' }),
        expect.objectContaining({ toStatus: 'CANCELLED' }),
        undefined,
      );
    });
  });
});
