import { RECOVERY_CODE_COUNT, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode } from './recovery-codes';

describe('recovery codes', () => {
  it('generates ten distinct 80-bit codes in groups of four', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });

  it('normalises case, spaces and dashes, and rejects anything else', () => {
    expect(normalizeRecoveryCode('abcd-efgh ijkl-mnop')).toBe('ABCDEFGHIJKLMNOP');
    expect(normalizeRecoveryCode('ABCD-EFGH-IJKL')).toBeNull();
    expect(normalizeRecoveryCode('ABCD-EFGH-IJKL-MNO1')).toBeNull();
  });

  it('hashes deterministically without containing the code', () => {
    const hash = hashRecoveryCode('ABCDEFGHIJKLMNOP');
    expect(hash).toBe(hashRecoveryCode('ABCDEFGHIJKLMNOP'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('ABCDEFGHIJKLMNOP');
    expect(hashRecoveryCode('ABCDEFGHIJKLMNOQ')).not.toBe(hash);
  });
});
