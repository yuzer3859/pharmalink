import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { REVIEW_MODERATION_PORT } from './application/ports/inbound/review-moderation.port';
import { ReviewService } from './application/review.service';
import { CustomerReviewsController, PublicReviewsController } from './interface/reviews.controllers';

/**
 * Module 15 — Reviews & Ratings, minimum (Work 91; architecture/module-15-reviews-ratings.md,
 * backend/docs/reviews.md). Verified-purchase pharmacy reviews from Module 06's order read port,
 * reports, automatic holding, the rating aggregate, and the moderation contract Module 16 uses.
 */
@Module({
  imports: [OrdersModule],
  controllers: [CustomerReviewsController, PublicReviewsController],
  providers: [ReviewService, { provide: REVIEW_MODERATION_PORT, useExisting: ReviewService }],
  exports: [REVIEW_MODERATION_PORT],
})
export class ReviewsModule {}
