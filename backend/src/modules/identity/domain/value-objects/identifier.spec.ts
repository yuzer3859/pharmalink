import { normalizeIdentifier } from './identifier';

describe('normalizeIdentifier', () => {
  it('normalizes every accepted local phone form to the same E.164 value', () => {
    for (const raw of ['0911234567', '911234567', '+251911234567', '251911234567']) {
      expect(normalizeIdentifier(raw)).toMatchObject({
        value: '+251911234567',
        channel: 'SMS',
      });
    }
  });

  it('lowercases and trims emails', () => {
    expect(normalizeIdentifier('  User@Example.COM ')).toMatchObject({
      value: 'user@example.com',
      channel: 'EMAIL',
    });
  });

  it('masks the value for safe logging', () => {
    expect(normalizeIdentifier('0911234567')?.masked).toBe('+2519****4567');
    expect(normalizeIdentifier('user@example.com')?.masked).toBe('us***@example.com');
  });

  it('returns null rather than throwing for junk input', () => {
    for (const raw of ['', 'garbage', '12345', 'no-at-sign.com', 'a@b']) {
      expect(normalizeIdentifier(raw)).toBeNull();
    }
  });
});
