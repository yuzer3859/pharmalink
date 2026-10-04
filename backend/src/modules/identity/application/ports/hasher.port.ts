export const HASHER = Symbol('HASHER');

/**
 * Password hashing port (module-01 §8). The default adapter is a dependency-free scrypt hasher;
 * an Argon2id adapter can replace it later without touching use cases (Open/Closed).
 */
export interface IHasher {
  hash(plaintext: string): Promise<string>;
  verify(plaintext: string, hash: string): Promise<boolean>;
}
