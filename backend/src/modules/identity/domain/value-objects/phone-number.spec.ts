import { PhoneNumber } from './phone-number';

describe('PhoneNumber', () => {
  it.each([
    ['0912345678', '+251912345678'],
    ['0712345678', '+251712345678'],
    ['912345678', '+251912345678'],
    ['+251912345678', '+251912345678'],
    ['251912345678', '+251912345678'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(PhoneNumber.create(input).value).toBe(expected);
  });

  it('rejects an invalid number', () => {
    expect(() => PhoneNumber.create('12345')).toThrow();
    expect(() => PhoneNumber.create('+1912345678')).toThrow();
  });

  it('masks the number for display', () => {
    const phone = PhoneNumber.create('0912345678');
    expect(phone.masked()).toBe('+2519****5678');
  });
});
