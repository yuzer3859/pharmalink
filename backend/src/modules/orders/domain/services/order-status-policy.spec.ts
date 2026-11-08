import { OrderStatus } from '../enums';
import { OrderStatusPolicy } from './order-status-policy';

describe('OrderStatusPolicy', () => {
  describe('legal Slice-1 transitions', () => {
    it.each([
      [OrderStatus.DRAFT, OrderStatus.PENDING_PAYMENT],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED],
      [OrderStatus.PAID, OrderStatus.ACCEPTED],
      [OrderStatus.PAID, OrderStatus.CANCELLED],
      [OrderStatus.ACCEPTED, OrderStatus.READY],
      [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
      // Work 103 (G14): the delivery advances the order.
      [OrderStatus.READY, OrderStatus.DISPATCHED],
      [OrderStatus.DISPATCHED, OrderStatus.DELIVERED],
    ])('allows %s -> %s', (from, to) => {
      expect(OrderStatusPolicy.isLegalTransition(from, to)).toBe(true);
      expect(() => OrderStatusPolicy.assertValidTransition(from, to)).not.toThrow();
    });
  });

  describe('illegal transitions', () => {
    it.each([
      [OrderStatus.DRAFT, OrderStatus.PAID],
      [OrderStatus.DRAFT, OrderStatus.CANCELLED],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.ACCEPTED],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.READY],
      [OrderStatus.PAID, OrderStatus.READY],
      [OrderStatus.PAID, OrderStatus.PENDING_PAYMENT],
      [OrderStatus.ACCEPTED, OrderStatus.PAID],
      [OrderStatus.ACCEPTED, OrderStatus.DISPATCHED],
      [OrderStatus.READY, OrderStatus.DELIVERED],
      [OrderStatus.READY, OrderStatus.CANCELLED],
      [OrderStatus.CANCELLED, OrderStatus.PAID],
      [OrderStatus.REFUNDED, OrderStatus.PAID],
    ])('rejects %s -> %s', (from, to) => {
      expect(OrderStatusPolicy.isLegalTransition(from, to)).toBe(false);
      expect(() => OrderStatusPolicy.assertValidTransition(from, to)).toThrow(
        expect.objectContaining({ code: 'INVALID_ORDER_STATE_TRANSITION' }),
      );
    });
  });

  describe('terminal states (Slice-1 reachable graph)', () => {
    it.each([
      OrderStatus.DELIVERED,
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDED,
    ])('%s has no legal outgoing transition', (status) => {
      expect(OrderStatusPolicy.isTerminal(status)).toBe(true);
    });

    it.each([OrderStatus.DRAFT, OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderStatus.ACCEPTED, OrderStatus.READY, OrderStatus.DISPATCHED])(
      '%s is not terminal',
      (status) => {
        expect(OrderStatusPolicy.isTerminal(status)).toBe(false);
      },
    );
  });

  it('never allows PREPARING as an Order status (it belongs to Fulfillment only)', () => {
    // PREPARING is not even a member of OrderStatus — this is a compile-time guarantee, but the
    // assertion below documents the intent explicitly: no Order enum member decodes to it.
    expect(Object.values(OrderStatus)).not.toContain('PREPARING');
  });
});
