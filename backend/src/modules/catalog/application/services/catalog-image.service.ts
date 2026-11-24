import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import {
  documentRef,
  DOCUMENT_STORAGE_PORT,
  IDocumentStoragePort,
  parseDocumentRef,
  SignedUrl,
  UPLOAD_URL_TTL_SECONDS,
} from '../../../../shared/storage/document-storage.port';
import { CatalogErrors } from '../../domain/errors';
import { IProductRepository, PRODUCT_REPOSITORY } from '../../domain/repositories/product.repository';

/** The storage namespace for product pictures: `doc:catalog-image/<productId>/<uuid>`. */
export const CATALOG_IMAGE_NAMESPACE = 'catalog-image';
export const CATALOG_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_CATALOG_IMAGE_BYTES = 5 * 1024 * 1024;
/** How long a picture's signed read link lives; the public route redirects to a fresh one. */
export const CATALOG_IMAGE_READ_TTL_SECONDS = 15 * 60;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A stored picture's public address, relative to the API: `/media/catalog/<productId>/<objectId>`. */
const MEDIA_URL = new RegExp(`^/media/catalog/(${UUID})/(${UUID})$`, 'i');
export const catalogImageUrl = (productId: string, objectId: string) => `/media/catalog/${productId}/${objectId}`;

export interface CatalogImageUpload {
  /** Where the picture will be served once uploaded; put it in the product's `images`. */
  imageUrl: string;
  upload: SignedUrl;
}

/**
 * Work 150: product pictures uploaded by catalogue staff. Before this, a picture could only be a
 * file shipped with the customer app (the Work 146 seed) or an outside https URL.
 *
 *  - `requestUpload`: a signed upload link for one picture (jpeg, png or webp, at most 5 MiB),
 *    stored under the product's id. Bytes go straight to storage, never through the API.
 *  - `assertUsable`: before images are saved, every stored-picture URL must be this product's own
 *    and actually uploaded, as an image. Shipped and https URLs pass through unchanged.
 *  - `readLink`: the public route's redirect target, a short-lived signed read of the picture.
 */
@Injectable()
export class CatalogImageService {
  constructor(
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort,
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    private readonly audit: AuditService,
  ) {}

  async requestUpload(input: { actorUserId: string; productId: string; contentType: string; bytes: number }): Promise<CatalogImageUpload> {
    if (!(CATALOG_IMAGE_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      throw CatalogErrors.validation(`A product picture must be one of ${CATALOG_IMAGE_CONTENT_TYPES.join(', ')}.`, { field: 'contentType' });
    }
    if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_CATALOG_IMAGE_BYTES) {
      throw CatalogErrors.validation(`A product picture must be between 1 byte and ${MAX_CATALOG_IMAGE_BYTES} bytes.`, { field: 'bytes' });
    }
    const product = await this.products.findById(input.productId);
    if (!product || product.deletedAt) throw CatalogErrors.notFound();
    if (!this.storage.available) {
      throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Picture uploads are not available.');
    }
    const objectId = randomUUID();
    const ref = documentRef(CATALOG_IMAGE_NAMESPACE, input.productId, objectId);
    const upload = await this.storage.signUpload(parseDocumentRef(ref)!, input.contentType, input.bytes, UPLOAD_URL_TTL_SECONDS);
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'CATALOG_IMAGE_UPLOAD_ISSUED',
      resourceType: 'Product',
      resourceId: input.productId,
      context: { objectId, contentType: input.contentType, bytes: input.bytes },
    });
    return { imageUrl: catalogImageUrl(input.productId, objectId), upload };
  }

  /** Throws a validation error naming the first stored-picture URL that isn't usable here. */
  async assertUsable(productId: string, urls: string[]): Promise<void> {
    for (const url of urls) {
      if (!url.startsWith('/media/')) continue;
      const m = MEDIA_URL.exec(url);
      if (!m || m[1].toLowerCase() !== productId.toLowerCase()) {
        throw CatalogErrors.validation('A stored picture must be one uploaded for this product.', { field: 'images', url });
      }
      const stored = await this.storage.describe(parseDocumentRef(documentRef(CATALOG_IMAGE_NAMESPACE, m[1], m[2]))!);
      if (!stored || !(CATALOG_IMAGE_CONTENT_TYPES as readonly string[]).includes(stored.contentType)) {
        throw CatalogErrors.validation('That picture has not been uploaded yet.', { field: 'images', url });
      }
    }
  }

  /** A short-lived read link for a stored picture, or not-found. */
  async readLink(productId: string, objectId: string): Promise<SignedUrl> {
    if (!MEDIA_URL.test(catalogImageUrl(productId, objectId)) || !this.storage.available) throw CatalogErrors.notFound();
    const ref = parseDocumentRef(documentRef(CATALOG_IMAGE_NAMESPACE, productId, objectId))!;
    const stored = await this.storage.describe(ref);
    if (!stored || !(CATALOG_IMAGE_CONTENT_TYPES as readonly string[]).includes(stored.contentType)) throw CatalogErrors.notFound();
    return this.storage.signRead(ref, stored.contentType, CATALOG_IMAGE_READ_TTL_SECONDS);
  }
}
