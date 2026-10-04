import { FulfillmentStatus } from '../enums';
import { FulfillmentStatusPolicy } from './fulfillment-status-policy';

describe('FulfillmentStatusPolicy', () => {
  describe('legal Slice-1 transitions', () => {
    it.each([
      [FulfillmentStatus.PENDING, FulfillmentStatus.ACCEPTED],
      [FulfillmentStatus.PENDING, FulfillmentStatus.CANCELLED],
      [FulfillmentStatus.ACCEPTED, FulfillmentStatus.PREPARING],
      [FulfillmentStatus.ACCEPTED, FulfillmentStatus.CANCELLED],
      [FulfillmentStatus.PREPARING, FulfillmentStatus.READY],
    ])('allows %s -> %s', (from, to) => {
      expect(FulfillmentStatusPolicy.isLegalTransition(from, to)).toBe(true);
      expect(() => FulfillmentStatusPolicy.assertValidTransition(from, to)).not.toThrow();
    });
  });

  describe('illegal transitions', () => {
    it.each([
      [FulfillmentStatus.PENDING, FulfillmentStatus.PREPARING],
      [FulfillmentStatus.PENDING, FulfillmentStatus.READY],
      [FulfillmentStatus.ACCEPTED, FulfillmentStatus.READY],
      [FulfillmentStatus.PREPARING, FulfillmentStatus.CANCELLED],
      [FulfillmentStatus.PREPARING, FulfillmentStatus.DISPATCHED],
      [FulfillmentStatus.READY, FulfillmentStatus.DISPATCHED],
      [FulfillmentStatus.CANCELLED, FulfillmentStatus.ACCEPTED],
    ])('rejects %s -> %s', (from, to) => {
      expect(FulfillmentStatusPolicy.isLegalTransition(from, to)).toBe(false);
      expect(() => FulfillmentStatusPolicy.assertValidTransition(from, to)).toThrow(
        expect.objectContaining({ code: 'INVALID_ORDER_STATE_TRANSITION', details: expect.objectContaining({ aggregate: 'fulfillment' }) }),
      );
    });
  });

  describe('terminal states (Slice-1 reachable graph)', () => {
    it.each([
      FulfillmentStatus.READY,
      FulfillmentStatus.DISPATCHED,
      FulfillmentStatus.DELIVERED,
      FulfillmentStatus.CANCELLED,
    ])('%s has no legal outgoing transition', (status) => {
      expect(FulfillmentStatusPolicy.isTerminal(status)).toBe(true);
    });

    it.each([FulfillmentStatus.PENDING, FulfillmentStatus.ACCEPTED, FulfillmentStatus.PREPARING])(
      '%s is not terminal',
      (status) => {
        expect(FulfillmentStatusPolicy.isTerminal(status)).toBe(false);
      },
    );
  });
});
