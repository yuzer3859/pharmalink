import { resolveDocumentStorage } from './document-storage.config';
import { documentRef, parseDocumentRef } from './document-storage.port';
import { InMemoryDocumentStorage } from './in-memory-document-storage';
import { S3DocumentStorage, UnavailableDocumentStorage } from './s3-document-storage';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OBJECT = '22222222-2222-4222-8222-222222222222';
const env = (values: Record<string, string>) => (key: string) => values[key];
const S3 = {
  DOCUMENT_STORAGE: 's3',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
  S3_BUCKET: 'pharmalink-documents',
  S3_ACCESS_KEY_ID: 'pharmalink-staging',
  S3_SECRET_ACCESS_KEY: 'x'.repeat(32),
};

describe('document storage (Work 89)', () => {
  describe('resolveDocumentStorage', () => {
    it('defaults to memory outside production and fails closed in production', () => {
      expect(resolveDocumentStorage(env({}))).toEqual({ kind: 'memory' });
      expect(resolveDocumentStorage(env({ NODE_ENV: 'production' }))).toEqual({ kind: 'unavailable' });
      expect(() => resolveDocumentStorage(env({ NODE_ENV: 'production', DOCUMENT_STORAGE: 'memory' }))).toThrow(/not allowed in production/);
      expect(() => resolveDocumentStorage(env({ DOCUMENT_STORAGE: 'disk' }))).toThrow();
    });

    it('requires every S3 setting and a real secret', () => {
      const s = resolveDocumentStorage(env(S3));
      expect(s.s3).toMatchObject({ endpoint: 'http://minio:9000', publicEndpoint: 'http://127.0.0.1:9000', region: 'us-east-1', forcePathStyle: true, createBucket: false });
      for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        expect(() => resolveDocumentStorage(env({ ...S3, [key]: '' }))).toThrow(key);
      }
      expect(() => resolveDocumentStorage(env({ ...S3, S3_SECRET_ACCESS_KEY: 'short' }))).toThrow(/16/);
    });
  });

  it('parses only well-formed doc: references', () => {
    const ref = documentRef('verification', OWNER, OBJECT);
    expect(parseDocumentRef(ref)).toEqual({ namespace: 'verification', ownerId: OWNER, objectId: OBJECT, key: `verification/${OWNER}/${OBJECT}` });
    for (const bad of ['enc://verification/x', `doc:verification/${OWNER}/../${OBJECT}`, `doc:Verification/${OWNER}/${OBJECT}`, `doc:verification/${OWNER}/${OBJECT}/x`, `${ref} `]) {
      expect({ bad, parsed: parseDocumentRef(bad) }).toEqual({ bad, parsed: null });
    }
  });

  describe('InMemoryDocumentStorage', () => {
    const ref = parseDocumentRef(documentRef('verification', OWNER, OBJECT))!;

    it('signs links that verify, and refuses altered or expired ones', async () => {
      let now = 1_000_000_000_000;
      const store = new InMemoryDocumentStorage('http://127.0.0.1:3000/', () => now);
      const link = await store.signUpload(ref, 'application/pdf', 10, 600);
      expect(link.url.startsWith('http://127.0.0.1:3000/storage/local/')).toBe(true);
      const token = link.url.split('/').pop()!;
      expect(store.verify(token)).toMatchObject({ key: ref.key, method: 'PUT', contentType: 'application/pdf', bytes: 10 });
      const [payload, mac] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), bytes: 99 })).toString('base64url');
      expect(store.verify(`${forged}.${mac}`)).toBeNull();
      expect(store.verify(payload)).toBeNull();
      // Another process's key does not verify this one's links.
      expect(new InMemoryDocumentStorage('http://x', () => now).verify(token)).toBeNull();
      now += 600_000;
      expect(store.verify(token)).toBeNull();
    });

    it('describes what was stored and nothing else', async () => {
      const store = new InMemoryDocumentStorage('http://x');
      expect(await store.describe(ref)).toBeNull();
      await store.put(ref, 'image/png', Buffer.from('png'));
      expect(await store.describe(ref)).toEqual({ contentType: 'image/png', bytes: 3 });
    });
  });

  describe('S3DocumentStorage', () => {
    const settings = resolveDocumentStorage(env(S3)).s3!;
    const ref = parseDocumentRef(documentRef('verification', OWNER, OBJECT))!;

    it('signs uploads for the browser-reachable endpoint, binding type and length', async () => {
      const link = await new S3DocumentStorage(settings).signUpload(ref, 'application/pdf', 1234, 600);
      const url = new URL(link.url);
      expect(url.origin).toBe('http://127.0.0.1:9000');
      expect(url.pathname).toBe(`/pharmalink-documents/verification/${OWNER}/${OBJECT}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
      expect(link.url).not.toContain(settings.secretAccessKey);
      expect(link.headers).toEqual({ 'Content-Type': 'application/pdf' });
    });

    it('signs reads that show the document inline and are not cached', async () => {
      const url = new URL((await new S3DocumentStorage(settings).signRead(ref, 'image/png', 300)).url);
      expect(url.searchParams.get('response-content-disposition')).toBe('inline');
      expect(url.searchParams.get('response-cache-control')).toBe('no-store');
      expect(url.searchParams.get('response-content-type')).toBe('image/png');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    });
  });

  it('refuses everything when no store is configured', async () => {
    const store = new UnavailableDocumentStorage();
    expect(store.available).toBe(false);
    await expect(store.describe()).rejects.toThrow('not configured');
  });
});
