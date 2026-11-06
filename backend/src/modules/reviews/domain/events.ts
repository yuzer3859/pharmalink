import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

export enum ReviewEventType {
  /** A moderator hid, removed or restored a review; its author is told. */
  ReviewModerated = 'reviews.review.moderated',
}

export interface ReviewModeratedPayload {
  reviewId: string;
  /** The author: the recipient of the notice. */
  userId: string;
  move: 'hide' | 'remove' | 'restore';
  status: string;
}

export function reviewModeratedEvent(payload: ReviewModeratedPayload): DomainEvent<ReviewModeratedPayload> {
  return createDomainEvent({ type: ReviewEventType.ReviewModerated, aggregateType: 'Review', aggregateId: payload.reviewId, payload });
}
