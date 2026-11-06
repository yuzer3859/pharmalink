export const DOCUMENT_STORAGE_PORT = Symbol('DOCUMENT_STORAGE_PORT');

/** The kinds of file a verification document may be (Work 89). */
export const ALLOWED_DOCUMENT_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentContentType = (typeof ALLOWED_DOCUMENT_CONTENT_TYPES)[number];
/** 10 MiB. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** How long an upload link works. */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
/** How long a preview link works. Short: it is a credential to a licence or an ID. */
export const PREVIEW_URL_TTL_SECONDS = 5 * 60;

/**
 * A stored document's reference: `doc:<namespace>/<ownerId>/<uuid>`. Opaque to everything but this
 * layer, and **not a URL**. The owner is part of the reference so a submission can be checked
 * against the caller without a lookup table.
 */
export const DOC_REF_PREFIX = 'doc:';
const REF = /^doc:([a-z][a-z-]{1,31})\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

export interface ParsedDocumentRef {
  namespace: string;
  ownerId: string;
  objectId: string;
  /** The key inside the store: `<namespace>/<ownerId>/<objectId>`. */
  key: string;
}

export function parseDocumentRef(ref: string): ParsedDocumentRef | null {
  const m = REF.exec(ref);
  return m ? { namespace: m[1], ownerId: m[2], objectId: m[3], key: `${m[1]}/${m[2]}/${m[3]}` } : null;
}

export const documentRef = (namespace: string, ownerId: string, objectId: string) => `${DOC_REF_PREFIX}${namespace}/${ownerId}/${objectId}`;

export interface SignedUrl {
  url: string;
  method: 'PUT' | 'GET';
  /** Headers the client must send with the request (the signature covers them). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredDocumentInfo {
  contentType: string;
  bytes: number;
}

/**
 * Object storage for documents people send the platform (Work 89, backend/docs/document-storage.md).
 *
 * Bytes never pass through the API: a client uploads straight to the store with a signed PUT and
 * a reviewer reads with a signed GET. The API only issues the links, checks what landed, and
 * audits who got a link. No method returns content, and no reference is a URL.
 */
export interface IDocumentStoragePort {
  /** `false` when no store is configured (production before a provider is approved). */
  readonly available: boolean;
  /** A signed PUT for exactly this content type and length. */
  signUpload(ref: ParsedDocumentRef, contentType: string, bytes: number, ttlSeconds: number): Promise<SignedUrl>;
  /** A signed GET that shows the document inline. */
  signRead(ref: ParsedDocumentRef, contentType: string, ttlSeconds: number): Promise<SignedUrl>;
  /** What is stored under the reference, or `null` if nothing is. Metadata only. */
  describe(ref: ParsedDocumentRef): Promise<StoredDocumentInfo | null>;
  /** Server-side write (the staging seed's sample documents). Not exposed over HTTP. */
  put(ref: ParsedDocumentRef, contentType: string, content: Buffer): Promise<void>;
}
