export const PICTURE_SUGGESTION_STORE = Symbol('PICTURE_SUGGESTION_STORE');

export type PictureSuggestionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface PictureSuggestionRow {
  id: string;
  productId: string;
  pharmacyId: string;
  url: string;
  status: PictureSuggestionStatus;
  suggestedById: string;
  decidedById: string | null;
  decisionReason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** A suggestion as catalogue staff review it, with the product's and the pharmacy's names. */
export interface PictureSuggestionReviewRow extends PictureSuggestionRow {
  productName: string | null;
  pharmacyName: string | null;
  /** How many pictures the product has now (at most 8). */
  productPictureCount: number;
}

/** Thrown by `create` when the same picture was already suggested. */
export class DuplicatePictureSuggestionError extends Error {}

/** Work 151: persistence for picture suggestions (`product_image_suggestions`). */
export interface IPictureSuggestionStore {
  create(input: { productId: string; pharmacyId: string; url: string; suggestedById: string }): Promise<PictureSuggestionRow>;
  countPending(pharmacyId: string, productId: string): Promise<number>;
  findById(id: string): Promise<PictureSuggestionRow | null>;
  /** The pharmacy's suggestions for one product, newest first. */
  forPharmacy(pharmacyId: string, productId: string, limit: number): Promise<PictureSuggestionRow[]>;
  /** Oldest first, so the longest-waiting is reviewed first. */
  listForReview(input: { status: PictureSuggestionStatus; skip: number; take: number }): Promise<{ items: PictureSuggestionReviewRow[]; total: number }>;
  /** Moves a still-PENDING suggestion to `status`; false when another decision came first. */
  decide(id: string, input: { status: 'APPROVED' | 'REJECTED'; decidedById: string; reason: string | null }): Promise<boolean>;
  /** Puts an approval that could not be applied back in the queue. */
  reopen(id: string): Promise<void>;
}
