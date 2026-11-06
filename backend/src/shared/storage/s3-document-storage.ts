import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3StorageSettings } from './document-storage.config';
import { IDocumentStoragePort, ParsedDocumentRef, SignedUrl, StoredDocumentInfo } from './document-storage.port';

/**
 * Document storage over the S3 API (`DOCUMENT_STORAGE=s3`). The staging stack points it at MinIO in
 * its own compose project; production has no approved provider and does not use it until one is.
 *
 * Two clients: one for the backend's own calls (`S3_ENDPOINT`, reachable inside the stack) and one
 * that only signs links (`S3_PUBLIC_ENDPOINT`, reachable from a browser). A signature covers the
 * host, so a link signed for `minio:9000` would not work from `127.0.0.1:9000`.
 */
export class S3DocumentStorage implements IDocumentStoragePort {
  readonly available = true;
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly settings: S3StorageSettings) {
    const base = {
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    };
    this.client = new S3Client({ ...base, endpoint: settings.endpoint });
    this.signer = new S3Client({ ...base, endpoint: settings.publicEndpoint });
  }

  /** Creates the bucket if `S3_CREATE_BUCKET=true` and it is missing (staging). */
  async ensureBucket(): Promise<void> {
    if (!this.settings.createBucket) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.settings.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.settings.bucket }));
    }
  }

  async signUpload(ref: ParsedDocumentRef, contentType: string, bytes: number, ttlSeconds: number): Promise<SignedUrl> {
    const command = new PutObjectCommand({ Bucket: this.settings.bucket, Key: ref.key, ContentType: contentType, ContentLength: bytes });
    const url = await getSignedUrl(this.signer, command, {
      expiresIn: ttlSeconds,
      // Signed, so the store refuses any other type or length.
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return { url, method: 'PUT', headers: { 'Content-Type': contentType }, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async signRead(ref: ParsedDocumentRef, contentType: string, ttlSeconds: number): Promise<SignedUrl> {
    const command = new GetObjectCommand({
      Bucket: this.settings.bucket,
      Key: ref.key,
      ResponseContentType: contentType,
      ResponseContentDisposition: 'inline',
      ResponseCacheControl: 'no-store',
    });
    const url = await getSignedUrl(this.signer, command, { expiresIn: ttlSeconds });
    return { url, method: 'GET', headers: {}, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async describe(ref: ParsedDocumentRef): Promise<StoredDocumentInfo | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: ref.key }));
      return { contentType: head.ContentType ?? 'application/octet-stream', bytes: Number(head.ContentLength ?? 0) };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async put(ref: ParsedDocumentRef, contentType: string, content: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: ref.key, ContentType: contentType, Body: content }));
  }
}

/** Production before a provider is approved: every operation refuses (`DOCUMENT_STORAGE_UNAVAILABLE`). */
export class UnavailableDocumentStorage implements IDocumentStoragePort {
  readonly available = false;
  private fail(): never {
    throw new Error('Document storage is not configured.');
  }
  async signUpload(): Promise<SignedUrl> {
    return this.fail();
  }
  async signRead(): Promise<SignedUrl> {
    return this.fail();
  }
  async describe(): Promise<StoredDocumentInfo | null> {
    return this.fail();
  }
  async put(): Promise<void> {
    return this.fail();
  }
}
