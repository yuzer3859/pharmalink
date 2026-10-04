import { ScryptHasher } from './scrypt-hasher';

describe('ScryptHasher', () => {
  const hasher = new ScryptHasher();

  it('round-trips a correct password', async () => {
    const hash = await hasher.hash('Str0ngPass');
    expect(await hasher.verify('Str0ngPass', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hasher.hash('Str0ngPass');
    expect(await hasher.verify('WrongPass1', hash)).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    const a = await hasher.hash('Str0ngPass');
    const b = await hasher.hash('Str0ngPass');
    expect(a).not.toBe(b);
  });

  it('rejects a malformed hash', async () => {
    expect(await hasher.verify('anything', 'not-a-valid-hash')).toBe(false);
  });
});
