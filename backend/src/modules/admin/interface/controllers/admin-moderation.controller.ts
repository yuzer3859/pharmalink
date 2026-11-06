import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiException } from '../../../../shared/errors/api-exception';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import {
  IReviewModerationPort,
  ModeratedReviewStatus,
  MODERATION_MOVES,
  ModerationMove,
  REVIEW_MODERATION_PORT,
} from '../../../reviews/application/ports/inbound/review-moderation.port';
import { FlaggedContentService } from '../../application/moderation/flagged-content.service';

const STATUSES: ModeratedReviewStatus[] = ['PENDING', 'PUBLISHED', 'REJECTED', 'FLAGGED', 'REMOVED', 'HIDDEN'];

export class ListModerationReviewsDto {
  @IsIn(STATUSES)
  @IsOptional()
  status?: ModeratedReviewStatus;

  /** `true`: the moderation queue (reported or held by a rule). */
  @Transform(({ obj }) => {
    const v = (obj as Record<string, unknown>).needsAttention;
    return v === 'true' ? true : v === 'false' ? false : v;
  })
  @IsBoolean()
  @IsOptional()
  needsAttention?: boolean;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  size?: number;
}

export class ModerateReviewDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Review moderation and the unified flagged-content view (Work 91, module-16 §9.3, F-AD-11,
 * module-15 §8.4, BRULE-46). `review:moderate:any` (ADMIN; SUPER_ADMIN by wildcard).
 *
 *     GET  /admin/moderation/flagged                      everything awaiting a content decision
 *     GET  /admin/reviews?status&needsAttention           reviews
 *     GET  /admin/reviews/{id}                            one, with its moderation log
 *     POST /admin/reviews/{id}/hide|remove|restore        {reason}
 *
 * Every decision is Module 15's: the status change, the log, the aggregate and the author's notice
 * happen through `REVIEW_MODERATION_PORT`.
 */
@Controller('admin')
@RequirePermissions('review:moderate:any')
export class AdminModerationController {
  constructor(
    @Inject(REVIEW_MODERATION_PORT) private readonly reviews: IReviewModerationPort,
    private readonly flagged: FlaggedContentService,
  ) {}

  @Get('moderation/flagged')
  overview() {
    return this.flagged.overview();
  }

  @Get('reviews')
  async list(@Query() q: ListModerationReviewsDto) {
    const page = q.page ?? 1;
    const size = q.size ?? 25;
    const r = await this.reviews.list({ status: q.status, needsAttention: q.needsAttention }, page, size);
    return { ...r, page, size };
  }

  @Get('reviews/:id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.reviews.get(id);
    if (!r) throw ApiException.notFound('Review not found');
    return r;
  }

  @Post('reviews/:id/:move')
  @HttpCode(HttpStatus.OK)
  moderate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('move') move: string,
    @Body() body: ModerateReviewDto,
    @Req() req: Request,
  ) {
    if (!(move in MODERATION_MOVES)) throw ApiException.notFound('Not found');
    return this.reviews.moderate({ reviewId: id, move: move as ModerationMove, reason: body.reason, moderatorUserId: user.userId, ip: req.ip ?? null });
  }
}
