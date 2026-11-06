import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { IDocumentStoragePort, ParsedDocumentRef, SignedUrl, StoredDocumentInfo } from './document-storage.port';

/** What a local link grants, signed by the process. */
export interface LocalGrant {
  key: string;
  method: 'PUT' | 'GET';
  contentType: string;
  /** Exact length for a PUT; ignored for a GET. */
  bytes: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/**
 * In-process document storage for tests and local development (`DOCUMENT_STORAGE=memory`).
 * Signed links point at this API's `/storage/local/{token}` (`LocalDocumentObjectController`), with
 * an HMAC key generated per process — the bytes live only as long as the process does, so the key
 * need not outlive it. Refused in production by `resolveDocumentStorage`.
 */
export class InMemoryDocumentStorage implements IDocumentStoragePort {
  readonly available = true;
  private readonly objects = new Map<string, { contentType: string; content: Buffer }>();
  private readonly key = randomBytes(32);

  constructor(private readonly publicBaseUrl: string, private readonly clock: () => number = () => Date.now()) {}

  async signUpload(ref: ParsedDocumentRef, contentType: string, bytes: number, ttlSeconds: number): Promise<SignedUrl> {
    return this.sign({ key: ref.key, method: 'PUT', contentType, bytes, exp: this.expiry(ttlSeconds) }, { 'Content-Type': contentType });
  }

  async signRead(ref: ParsedDocumentRef, contentType: string, ttlSeconds: number): Promise<SignedUrl> {
    return this.sign({ key: ref.key, method: 'GET', contentType, bytes: 0, exp: this.expiry(ttlSeconds) }, {});
  }

  async describe(ref: ParsedDocumentRef): Promise<StoredDocumentInfo | null> {
    const o = this.objects.get(ref.key);
    return o ? { contentType: o.contentType, bytes: o.content.length } : null;
  }

  async put(ref: ParsedDocumentRef, contentType: string, content: Buffer): Promise<void> {
    this.objects.set(ref.key, { contentType, content: Buffer.from(content) });
  }

  /** The grant behind a token, or `null` if it is forged, altered or expired. */
  verify(token: string): LocalGrant | null {
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = createHmac('sha256', this.key).update(payload).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalGrant;
      return grant.exp * 1000 > this.clock() ? grant : null;
    } catch {
      return null;
    }
  }

  /** Stores a PUT's bytes under the grant's key. */
  write(grant: LocalGrant, content: Buffer): void {
    this.objects.set(grant.key, { contentType: grant.contentType, content });
  }

  read(grant: LocalGrant): { contentType: string; content: Buffer } | null {
    return this.objects.get(grant.key) ?? null;
  }

  private expiry(ttlSeconds: number) {
    return Math.floor(this.clock() / 1000) + ttlSeconds;
  }

  private sign(grant: LocalGrant, headers: Record<string, string>): SignedUrl {
    const payload = b64(JSON.stringify(grant));
    const mac = createHmac('sha256', this.key).update(payload).digest('base64url');
    return {
      url: `${this.publicBaseUrl.replace(/\/$/, '')}/storage/local/${payload}.${mac}`,
      method: grant.method,
      headers,
      expiresAt: new Date(grant.exp * 1000),
    };
  }
}
