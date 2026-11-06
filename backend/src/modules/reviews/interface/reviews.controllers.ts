import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../../shared/rbac/public.decorator';
import { RequirePermissions } from '../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../identity/interface/decorators/current-user.decorator';
import { ReviewService } from '../application/review.service';
import { PageQueryDto, ReportReviewDto, ReviewContentDto, SubmitReviewDto } from './reviews.dto';

const actor = (user: AuthenticatedPrincipal, req: Request) => ({ userId: user.userId, ip: req.ip ?? null });

/**
 * A customer's reviews (Work 91, module-15 §8.1, §8.2): write one for a received order, edit it
 * within 14 days, see one's own, report someone else's. `review:create:own` (CUSTOMER).
 */
@Controller('reviews')
@RequirePermissions('review:create:own')
export class CustomerReviewsController {
  constructor(private readonly reviews: ReviewService) {}

  @Post()
  submit(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: SubmitReviewDto, @Req() req: Request) {
    return this.reviews.submit(body, actor(user, req));
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.reviews.mine(user.userId);
  }

  @Patch(':id')
  edit(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ReviewContentDto, @Req() req: Request) {
    return this.reviews.edit(id, body, actor(user, req));
  }

  @Post(':id/report')
  @HttpCode(HttpStatus.OK)
  report(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ReportReviewDto, @Req() req: Request) {
    return this.reviews.report(id, body, actor(user, req));
  }
}

/**
 * Published reviews and the rating of a pharmacy (module-15 §8.2). Public: no sign-in, no author,
 * no order. Only PHARMACY is a subject in Phase 1.
 */
@Controller('subjects/PHARMACY')
@Public()
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewService) {}

  @Get(':id/reviews')
  list(@Param('id', new ParseUUIDPipe()) id: string, @Query() q: PageQueryDto) {
    return this.reviews.forSubject('PHARMACY', id, q.page ?? 1, q.size ?? 20);
  }

  @Get(':id/rating')
  rating(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.reviews.rating('PHARMACY', id);
  }
}
