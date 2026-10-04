import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import { IHasher } from '../../application/ports/hasher.port';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Dependency-free, memory-hard password hasher (Node's built-in scrypt, N=2^14 default cost).
 * Implements the IHasher port so it can be swapped for an Argon2id adapter later (module-01 §8)
 * without touching any use case — this slice avoids the native-build dependency that Argon2
 * bindings require.
 */
@Injectable()
export class ScryptHasher implements IHasher {
  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derivedKey = (await scryptAsync(plaintext, salt, KEY_LENGTH)) as Buffer;
    return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    const parts = hash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return false;
    }
    const [, saltHex, keyHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const expectedKey = Buffer.from(keyHex, 'hex');
    const derivedKey = (await scryptAsync(plaintext, salt, expectedKey.length)) as Buffer;
    return (
      derivedKey.length === expectedKey.length && timingSafeEqual(derivedKey, expectedKey)
    );
  }
}
