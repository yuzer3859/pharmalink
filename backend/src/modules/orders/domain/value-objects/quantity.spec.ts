import { Quantity } from './quantity';

describe('Quantity', () => {
  it.each([1, 2, 10, 1000])('accepts a positive integer %d', (value) => {
    expect(Quantity.of(value).value).toBe(value);
  });

  it.each([0, -1, -100])('rejects zero/negative quantity %d', (value) => {
    expect(() => Quantity.of(value)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it.each([1.5, 2.1, NaN, Infinity])('rejects a non-integer quantity %p', (value) => {
    expect(() => Quantity.of(value)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});
