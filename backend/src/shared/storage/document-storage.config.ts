/**
 * Which document storage the process uses (Work 89, backend/docs/document-storage.md).
 *
 *   DOCUMENT_STORAGE=memory   in-process, signed links served by this API (tests, local dev). Lost on restart.
 *   DOCUMENT_STORAGE=s3       any S3-compatible store; the staging stack runs MinIO in its own compose project.
 *
 * Unset means `memory` outside production and **unavailable** in production: no object-storage
 * provider is approved for production, so uploads and previews fail closed there (`memory` is
 * refused in production) until one is, exactly as payouts do (Work 83).
 */
export type DocumentStorageKind = 'memory' | 's3' | 'unavailable';

export interface S3StorageSettings {
  /** Where the backend reaches the store, e.g. `http://minio:9000`. */
  endpoint: string;
  /** What signed links carry, e.g. `http://127.0.0.1:9000` (the browser cannot resolve `minio`). */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Create the bucket at start-up if missing. Staging only; production buckets are provisioned. */
  createBucket: boolean;
}

export interface DocumentStorageSettings {
  kind: DocumentStorageKind;
  s3?: S3StorageSettings;
}

type Read = (key: string) => unknown;

const str = (read: Read, key: string) => {
  const v = read(key);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

export function resolveDocumentStorage(read: Read): DocumentStorageSettings {
  const production = str(read, 'NODE_ENV') === 'production';
  const requested = str(read, 'DOCUMENT_STORAGE');
  if (requested && !['memory', 's3'].includes(requested)) {
    throw new Error('DOCUMENT_STORAGE must be "memory" or "s3".');
  }
  if (!requested) return { kind: production ? 'unavailable' : 'memory' };
  if (requested === 'memory') {
    if (production) throw new Error('DOCUMENT_STORAGE=memory is not allowed in production.');
    return { kind: 'memory' };
  }
  const need = (key: string) => {
    const v = str(read, key);
    if (!v) throw new Error(`DOCUMENT_STORAGE=s3 requires ${key}.`);
    return v;
  };
  const endpoint = need('S3_ENDPOINT');
  const secretAccessKey = need('S3_SECRET_ACCESS_KEY');
  if (secretAccessKey.length < 16) throw new Error('S3_SECRET_ACCESS_KEY must be at least 16 characters.');
  return {
    kind: 's3',
    s3: {
      endpoint,
      publicEndpoint: str(read, 'S3_PUBLIC_ENDPOINT') ?? endpoint,
      region: str(read, 'S3_REGION') ?? 'us-east-1',
      bucket: need('S3_BUCKET'),
      accessKeyId: need('S3_ACCESS_KEY_ID'),
      secretAccessKey,
      forcePathStyle: str(read, 'S3_FORCE_PATH_STYLE') !== 'false',
      createBucket: str(read, 'S3_CREATE_BUCKET') === 'true',
    },
  };
}
