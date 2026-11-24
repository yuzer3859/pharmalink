import type { CatalogImageUpload } from '../../services/catalog-image.service';
import type { PictureSuggestionStatus } from '../picture-suggestion.store';

export const CATALOG_PICTURE_SUGGESTION_PORT = Symbol('CATALOG_PICTURE_SUGGESTION_PORT');

export interface PictureSuggestionView {
  id: string;
  productId: string;
  imageUrl: string;
  status: PictureSuggestionStatus;
  /** Why catalogue staff turned it down, when they did. */
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * Work 151: Module 04's way into picture suggestions. Its inventory routes resolve the caller's
 * pharmacy and the listing's product (so a pharmacy reaches only products it stocks) and pass
 * both in; this module checks the picture and keeps the suggestion until staff decide.
 */
export interface ICatalogPictureSuggestionPort {
  requestUpload(input: { actorUserId: string; pharmacyId: string; productId: string; contentType: string; bytes: number }): Promise<CatalogImageUpload>;
  suggest(input: { actorUserId: string; pharmacyId: string; productId: string; imageUrl: string }): Promise<PictureSuggestionView>;
  /** The product's current pictures and this pharmacy's suggestions for it, newest first. */
  forPharmacy(input: { pharmacyId: string; productId: string }): Promise<{ images: string[]; suggestions: PictureSuggestionView[] }>;
}
