/**
 * Serializable envelope-encrypted payload. Only this (never plaintext) is persisted, in the
 * `*Ref` columns of health/PII tables (see ADR-009). `wrappedKey` is the per-record data key
 * encrypted under the master/KMS key; the master key itself is never stored.
 */
export interface EncryptedPayload {
  v: 1;
  wrappedKey: string; // base64 — data key encrypted with master key
  keyIv: string; // base64 — IV used to wrap the data key
  keyTag: string; // base64 — GCM auth tag for the wrapped data key
  iv: string; // base64 — IV used to encrypt the payload
  tag: string; // base64 — GCM auth tag for the payload
  ciphertext: string; // base64 — encrypted payload
}

export const ENCRYPTION_PORT = Symbol('ENCRYPTION_PORT');

export interface IEncryptionPort {
  encrypt(plaintext: string | Buffer): EncryptedPayload;
  decrypt(payload: EncryptedPayload): Buffer;
  encryptToString(plaintext: string | Buffer): string;
  decryptFromString(serialized: string): Buffer;
}
