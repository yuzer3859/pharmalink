import { isWithinEthiopia } from './geo-bounds';

describe('isWithinEthiopia', () => {
  it('accepts a coordinate inside the bounding box (Addis Ababa)', () => {
    expect(isWithinEthiopia(9.03, 38.74)).toBe(true);
  });

  it('rejects a coordinate outside the bounding box (Nairobi, Kenya)', () => {
    expect(isWithinEthiopia(-1.286389, 36.817223)).toBe(false);
  });

  it('accepts the exact boundary values', () => {
    expect(isWithinEthiopia(3.397, 32.998)).toBe(true);
    expect(isWithinEthiopia(14.894, 47.978)).toBe(true);
  });

  it('rejects values just outside the boundary', () => {
    expect(isWithinEthiopia(3.396, 40)).toBe(false);
    expect(isWithinEthiopia(9, 48)).toBe(false);
  });
});
