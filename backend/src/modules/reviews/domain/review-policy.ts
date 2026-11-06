import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/** How long after writing a review its author may still edit it (BRULE-47). */
export const EDIT_WINDOW_DAYS = 14;
/** Distinct reports that take a published review out of public view until a moderator decides. */
export const REPORTS_TO_FLAG = 3;
export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 2000;
export const MAX_REPORT_DETAIL_LENGTH = 500;

/** Why a review was reported (module-15 F-MOD-02). */
export const REPORT_REASONS = ['SPAM', 'ABUSIVE', 'OFF_TOPIC', 'PERSONAL_DATA', 'HEALTH_DETAIL', 'OTHER'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The moderation moves a reviewer can make (BRULE-46), and from which statuses. */
export const MODERATION_MOVES = {
  hide: { from: ['PUBLISHED', 'FLAGGED'], to: 'HIDDEN', action: 'REJECT' },
  remove: { from: ['PUBLISHED', 'FLAGGED', 'HIDDEN'], to: 'REMOVED', action: 'REMOVE' },
  restore: { from: ['FLAGGED', 'HIDDEN'], to: 'PUBLISHED', action: 'RESTORE' },
} as const;
export type ModerationMove = keyof typeof MODERATION_MOVES;

/** Orders that can be reviewed: the customer has received them (BRULE-45). */
export const REVIEWABLE_ORDER_STATUSES = ['DELIVERED', 'COMPLETED'];

export const ReviewErrors = {
  notEligible: (reason: string) =>
    new ApiException(ErrorCode.TRANSACTION_NOT_ELIGIBLE, 'This order cannot be reviewed.', { reason }),
  alreadyReviewed: () => new ApiException(ErrorCode.ALREADY_REVIEWED, 'You already reviewed this pharmacy for this order.'),
  editWindowClosed: () => new ApiException(ErrorCode.EDIT_WINDOW_CLOSED, `A review can be edited for ${EDIT_WINDOW_DAYS} days.`),
  notFound: () => new ApiException(ErrorCode.REVIEW_NOT_FOUND, 'Review not found.'),
  invalidMove: (from: string, move: string) =>
    new ApiException(ErrorCode.INVALID_MODERATION_TRANSITION, `A ${from} review cannot be ${move === 'hide' ? 'hidden' : move === 'remove' ? 'removed' : 'restored'}.`, { from, move }),
  notEditable: (status: string) =>
    new ApiException(ErrorCode.INVALID_MODERATION_TRANSITION, `A ${status.toLowerCase()} review cannot be edited.`, { from: status }),
  validation: (message: string) => new ApiException(ErrorCode.VALIDATION_ERROR, message),
};

export interface ReviewContent {
  rating: number;
  title?: string | null;
  body?: string | null;
}

/** Trims and checks a review's content; throws `VALIDATION_ERROR`. */
export function normalizeContent(input: ReviewContent): { rating: number; title: string | null; body: string | null } {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw ReviewErrors.validation('A rating is a whole number from 1 to 5.');
  const title = input.title?.trim() || null;
  const body = input.body?.trim() || null;
  if (title && title.length > MAX_TITLE_LENGTH) throw ReviewErrors.validation(`A title is at most ${MAX_TITLE_LENGTH} characters.`);
  if (body && body.length > MAX_BODY_LENGTH) throw ReviewErrors.validation(`A review is at most ${MAX_BODY_LENGTH} characters.`);
  return { rating: input.rating, title, body };
}

const LINK = /\b(?:https?:\/\/|www\.)\S+/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Ethiopian mobile numbers (+251 9…, 09…, 07…), with or without separators.
const PHONE = /(?:\+?251[\s-]?|\b0)[79](?:[\s-]?\d){8}\b/;

/**
 * The automatic content rules (BRULE-46, BRULE-37). A review that trips one is not refused: it is
 * held as FLAGGED, out of public view, for a moderator. Links, e-mail addresses and phone numbers
 * are spam or someone's personal data in a review of a pharmacy. Returns the rules that matched.
 */
export function autoFlags(content: { title: string | null; body: string | null }): string[] {
  const text = `${content.title ?? ''}\n${content.body ?? ''}`;
  const flags: string[] = [];
  if (LINK.test(text)) flags.push('LINK');
  if (EMAIL.test(text)) flags.push('EMAIL');
  if (PHONE.test(text)) flags.push('PHONE');
  return flags;
}

export const withinEditWindow = (createdAt: Date, now: Date) => now.getTime() - createdAt.getTime() <= EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The aggregate of published ratings: count, mean (2 dp) and how many of each star. */
export function aggregate(ratings: number[]): { ratingCount: number; ratingAvg: number; distribution: Record<'1' | '2' | '3' | '4' | '5', number> } {
  const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const r of ratings) distribution[String(r) as keyof typeof distribution]++;
  const ratingCount = ratings.length;
  const ratingAvg = ratingCount ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratingCount) * 100) / 100 : 0;
  return { ratingCount, ratingAvg, distribution };
}
