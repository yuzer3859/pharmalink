import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { CatalogErrors } from '../../domain/errors';
import { IProductRepository, PRODUCT_REPOSITORY } from '../../domain/repositories/product.repository';
import { UpdateProductCommand } from '../commands/update-product.command';
import { ICatalogPictureSuggestionPort, PictureSuggestionView } from '../ports/inbound/catalog-picture-suggestion.port';
import {
  DuplicatePictureSuggestionError,
  IPictureSuggestionStore,
  PICTURE_SUGGESTION_STORE,
  PictureSuggestionRow,
  PictureSuggestionStatus,
} from '../ports/picture-suggestion.store';
import { CatalogImageService } from './catalog-image.service';

/** A pharmacy may have this many suggestions waiting for one product. */
export const MAX_PENDING_PICTURE_SUGGESTIONS = 3;
/** A product holds at most this many pictures (the `images` limit since Work 145). */
export const MAX_PRODUCT_PICTURES = 8;
export const PICTURE_SUGGESTION_STATUSES: readonly PictureSuggestionStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];
export const PICTURE_REJECT_REASON_MIN = 3;
export const PICTURE_REJECT_REASON_MAX = 300;
const PHARMACY_HISTORY = 20;

export interface PictureSuggestionReviewItem extends PictureSuggestionView {
  productName: string | null;
  pharmacyId: string;
  pharmacyName: string | null;
  productPictureCount: number;
}

const view = (row: PictureSuggestionRow): PictureSuggestionView => ({
  id: row.id,
  productId: row.productId,
  imageUrl: row.url,
  status: row.status,
  reason: row.decisionReason,
  createdAt: row.createdAt.toISOString(),
  decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
});

const alreadyDecided = () => new ApiException(ErrorCode.CONFLICT, 'This picture has already been decided.');

/**
 * Work 151: pictures pharmacies suggest for products they stock (owner decision 2026-11-24).
 * Product pictures are shared by every pharmacy that stocks the product, so a suggestion changes
 * nothing for customers until catalogue staff approve it; approval appends the picture to the
 * product's images through `UpdateProductCommand` (audit, search refresh), rejection records why.
 * Upload and storage are Work 150's: the same signed upload, the same public `/media/` address.
 */
@Injectable()
export class CatalogPictureSuggestionService implements ICatalogPictureSuggestionPort {
  constructor(
    @Inject(PICTURE_SUGGESTION_STORE) private readonly store: IPictureSuggestionStore,
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    private readonly catalogImages: CatalogImageService,
    private readonly updateProduct: UpdateProductCommand,
    private readonly audit: AuditService,
  ) {}

  async requestUpload(input: { actorUserId: string; pharmacyId: string; productId: string; contentType: string; bytes: number }) {
    await this.assertRoom(input.pharmacyId, input.productId);
    return this.catalogImages.requestUpload({ actorUserId: input.actorUserId, productId: input.productId, contentType: input.contentType, bytes: input.bytes });
  }

  async suggest(input: { actorUserId: string; pharmacyId: string; productId: string; imageUrl: string }): Promise<PictureSuggestionView> {
    if (!input.imageUrl.startsWith('/media/')) {
      throw CatalogErrors.validation('Upload the picture first, then suggest it.', { field: 'imageUrl' });
    }
    await this.catalogImages.assertUsable(input.productId, [input.imageUrl]);
    if ((await this.products.imageUrlsFor(input.productId)).includes(input.imageUrl)) {
      throw CatalogErrors.validation('That picture is already on the product.', { field: 'imageUrl' });
    }
    await this.assertRoom(input.pharmacyId, input.productId);
    let row: PictureSuggestionRow;
    try {
      row = await this.store.create({ productId: input.productId, pharmacyId: input.pharmacyId, url: input.imageUrl, suggestedById: input.actorUserId });
    } catch (error) {
      if (error instanceof DuplicatePictureSuggestionError) {
        throw CatalogErrors.validation('That picture has already been suggested.', { field: 'imageUrl' });
      }
      throw error;
    }
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'CATALOG_IMAGE_SUGGESTED',
      resourceType: 'Product',
      resourceId: input.productId,
      context: { suggestionId: row.id, pharmacyId: input.pharmacyId },
    });
    return view(row);
  }

  async forPharmacy(input: { pharmacyId: string; productId: string }) {
    const [images, rows] = await Promise.all([
      this.products.imageUrlsFor(input.productId),
      this.store.forPharmacy(input.pharmacyId, input.productId, PHARMACY_HISTORY),
    ]);
    return { images, suggestions: rows.map(view) };
  }

  async listForReview(input: { status?: PictureSuggestionStatus; page?: number; size?: number }) {
    const page = input.page ?? 1;
    const size = input.size ?? 20;
    const { items, total } = await this.store.listForReview({ status: input.status ?? 'PENDING', skip: (page - 1) * size, take: size });
    return {
      items: items.map(
        (row): PictureSuggestionReviewItem => ({
          ...view(row),
          productName: row.productName,
          pharmacyId: row.pharmacyId,
          pharmacyName: row.pharmacyName,
          productPictureCount: row.productPictureCount,
        }),
      ),
      meta: { page, size, total },
    };
  }

  /** Adds the picture to the end of the product's pictures; staff can reorder them after. */
  async approve(input: { actorUserId: string; suggestionId: string }): Promise<PictureSuggestionView & { images: string[] }> {
    const found = await this.store.findById(input.suggestionId);
    if (!found) throw CatalogErrors.notFound();
    if (found.status !== 'PENDING') throw alreadyDecided();
    const current = await this.products.imageUrlsFor(found.productId);
    if (!current.includes(found.url) && current.length >= MAX_PRODUCT_PICTURES) {
      throw CatalogErrors.validation(`The product already has ${MAX_PRODUCT_PICTURES} pictures. Remove one first.`);
    }
    if (!(await this.store.decide(found.id, { status: 'APPROVED', decidedById: input.actorUserId, reason: null }))) throw alreadyDecided();
    let images: string[];
    try {
      const updated = await this.updateProduct.execute({
        actorUserId: input.actorUserId,
        productId: found.productId,
        images: current.includes(found.url) ? current : [...current, found.url],
      });
      images = updated.images;
    } catch (error) {
      await this.store.reopen(found.id);
      throw error;
    }
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'CATALOG_IMAGE_SUGGESTION_APPROVED',
      resourceType: 'Product',
      resourceId: found.productId,
      context: { suggestionId: found.id, pharmacyId: found.pharmacyId },
    });
    return { ...view((await this.store.findById(found.id))!), images };
  }

  async reject(input: { actorUserId: string; suggestionId: string; reason: string }): Promise<PictureSuggestionView> {
    const reason = input.reason.trim();
    if (reason.length < PICTURE_REJECT_REASON_MIN || reason.length > PICTURE_REJECT_REASON_MAX) {
      throw CatalogErrors.validation(`A reason of ${PICTURE_REJECT_REASON_MIN}–${PICTURE_REJECT_REASON_MAX} characters is required.`, { field: 'reason' });
    }
    const found = await this.store.findById(input.suggestionId);
    if (!found) throw CatalogErrors.notFound();
    if (!(await this.store.decide(found.id, { status: 'REJECTED', decidedById: input.actorUserId, reason }))) throw alreadyDecided();
    await this.audit.record({
      actorUserId: input.actorUserId,
      action: 'CATALOG_IMAGE_SUGGESTION_REJECTED',
      resourceType: 'Product',
      resourceId: found.productId,
      context: { suggestionId: found.id, pharmacyId: found.pharmacyId, reason },
    });
    return view((await this.store.findById(found.id))!);
  }

  private async assertRoom(pharmacyId: string, productId: string): Promise<void> {
    if ((await this.store.countPending(pharmacyId, productId)) >= MAX_PENDING_PICTURE_SUGGESTIONS) {
      throw CatalogErrors.validation(
        `You already have ${MAX_PENDING_PICTURE_SUGGESTIONS} pictures waiting for this product. Wait for them to be reviewed.`,
        { field: 'imageUrl' },
      );
    }
  }
}
