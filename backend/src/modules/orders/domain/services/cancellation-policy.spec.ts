import { OrderStatus } from '../enums';
import { CancellationPolicy } from './cancellation-policy';

describe('CancellationPolicy', () => {
  describe('cancellable statuses', () => {
    it.each([
      OrderStatus.DRAFT,
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.PAID,
      OrderStatus.ACCEPTED,
    ])('%s can be cancelled', (status) => {
      expect(CancellationPolicy.canCancel(status)).toBe(true);
      expect(() => CancellationPolicy.assertCanCancel(status)).not.toThrow();
    });
  });

  describe('non-cancellable statuses', () => {
    it.each([
      OrderStatus.READY,
      OrderStatus.DISPATCHED,
      OrderStatus.DELIVERED,
      OrderStatus.COMPLETED,
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDED,
    ])('%s cannot be cancelled', (status) => {
      expect(CancellationPolicy.canCancel(status)).toBe(false);
      expect(() => CancellationPolicy.assertCanCancel(status)).toThrow(
        expect.objectContaining({ code: 'CANCELLATION_NOT_ALLOWED' }),
      );
    });
  });
});
