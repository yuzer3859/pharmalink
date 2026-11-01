import {
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  matchTotp,
  timeStepAt,
  totpForStep,
} from './totp';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1, 8 digits. Secret is the ASCII string "12345678901234567890".
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC test vector at T=%i', (seconds, expected) => {
    expect(totpForStep(rfcSecret, Math.floor(seconds / TOTP_PERIOD_SECONDS), 8)).toBe(expected);
  });

  it('produces the six-digit code as the last six digits of the RFC value', () => {
    expect(totpForStep(rfcSecret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('round-trips base32 and matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(() => base32Decode('NOT-BASE32!')).toThrow();
  });

  describe('matchTotp', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = timeStepAt(now);

    it('accepts the current step and one step either side, and reports which', () => {
      expect(matchTotp(secret, totpForStep(secret, step), now)).toBe(step);
      expect(matchTotp(secret, totpForStep(secret, step - 1), now)).toBe(step - 1);
      expect(matchTotp(secret, totpForStep(secret, step + 1), now)).toBe(step + 1);
    });

    it('rejects codes two steps away (outside the ±30 s skew window)', () => {
      expect(matchTotp(secret, totpForStep(secret, step - 2), now)).toBeNull();
      expect(matchTotp(secret, totpForStep(secret, step + 2), now)).toBeNull();
    });

    it('rejects malformed codes and another secret’s code', () => {
      expect(matchTotp(secret, '12345', now)).toBeNull();
      expect(matchTotp(secret, 'abcdef', now)).toBeNull();
      expect(matchTotp(secret, `${totpForStep(secret, step)}0`, now)).toBeNull();
      const other = generateTotpSecret();
      const code = totpForStep(other, step);
      const collides = [step - 1, step, step + 1].some((s) => totpForStep(secret, s) === code);
      if (!collides) expect(matchTotp(secret, code, now)).toBeNull();
    });
  });

  it('builds an otpauth URI with the standard parameters', () => {
    const uri = new URL(buildOtpauthUri({ issuer: 'PharmaLink', account: 'ops@example.com', secretBase32: 'ABCDEFGH' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/PharmaLink:ops@example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'ABCDEFGH',
      issuer: 'PharmaLink',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
