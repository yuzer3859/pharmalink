import { AppConfigService } from '../config/app-config.service';
import { CryptoService } from './crypto.service';

function makeService(): CryptoService {
  const key = Buffer.alloc(32, 7).toString('base64');
  const configStub = { masterEncryptionKey: key } as unknown as AppConfigService;
  return new CryptoService(configStub);
}

describe('CryptoService (envelope encryption)', () => {
  it('round-trips a string payload', () => {
    const svc = makeService();
    const plaintext = 'sensitive: prescription #12345 for patient';
    const payload = svc.encrypt(plaintext);
    expect(payload.ciphertext).not.toContain('prescription');
    expect(svc.decrypt(payload).toString('utf8')).toBe(plaintext);
  });

  it('round-trips via the serialized string form', () => {
    const svc = makeService();
    const serialized = svc.encryptToString('hello ወዲ');
    expect(svc.decryptFromString(serialized).toString('utf8')).toBe('hello ወዲ');
  });

  it('produces a unique data key / ciphertext per call (non-deterministic)', () => {
    const svc = makeService();
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it('fails authentication if the ciphertext is tampered with', () => {
    const svc = makeService();
    const payload = svc.encrypt('integrity matters');
    const tampered = { ...payload, ciphertext: Buffer.from('evil').toString('base64') };
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => CryptoService.decodeMasterKey(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});
