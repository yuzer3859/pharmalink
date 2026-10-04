import { PasswordPolicy } from './password-policy';

describe('PasswordPolicy', () => {
  const policy = new PasswordPolicy();

  it('accepts a strong password', () => {
    expect(policy.isValid('Str0ngPass')).toBe(true);
    expect(policy.check('Str0ngPass')).toEqual([]);
  });

  it('flags a too-short password', () => {
    expect(policy.isValid('Ab1')).toBe(false);
  });

  it('flags missing character classes', () => {
    expect(policy.check('alllowercase1')).toContain('Must contain an uppercase letter.');
    expect(policy.check('ALLUPPERCASE1')).toContain('Must contain a lowercase letter.');
    expect(policy.check('NoDigitsHere')).toContain('Must contain a digit.');
  });

  it('assert() throws AUTH_WEAK_PASSWORD for a weak password', () => {
    expect(() => policy.assert('weak')).toThrow();
  });

  it('assert() does not throw for a strong password', () => {
    expect(() => policy.assert('Str0ngPass')).not.toThrow();
  });
});
