import { RxClassificationPolicy } from './rx-classification-policy';

/**
 * Module 06's copy of the Rx-classification rule. Module 05 keeps an identical copy
 * (`modules/prescription-matching/domain/services/rx-classification-policy.spec.ts`) asserting
 * exactly the same table — the two must agree, since `CheckoutCommand` decides which lines to
 * send to the gate and `CheckRxGateCommand` decides how to answer for them.
 */
describe('RxClassificationPolicy (orders)', () => {
  it.each([
    ['RX', true],
    ['OTC', false],
    [null, false],
    [undefined, false],
  ])('requiresPrescription(%p) -> %p', (classification, expected) => {
    expect(
      RxClassificationPolicy.requiresPrescription(classification as string | null | undefined),
    ).toBe(expected);
  });

  it('does not treat an arbitrary non-RX string as requiring a prescription', () => {
    // The catalog enum defines only RX and OTC; anything else is bad data, and defaulting it to
    // "needs a prescription" is what the previous Boolean() check effectively did to 'OTC'.
    expect(RxClassificationPolicy.requiresPrescription('SOMETHING_ELSE')).toBe(false);
  });

  it('is case-sensitive — only the exact catalog enum member counts', () => {
    expect(RxClassificationPolicy.requiresPrescription('rx')).toBe(false);
    expect(RxClassificationPolicy.requiresPrescription('RX')).toBe(true);
  });
});
