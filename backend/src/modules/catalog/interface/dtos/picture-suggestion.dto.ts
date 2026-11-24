import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  PICTURE_REJECT_REASON_MAX,
  PICTURE_REJECT_REASON_MIN,
  PICTURE_SUGGESTION_STATUSES,
} from '../../application/services/catalog-picture-suggestion.service';
import type { PictureSuggestionStatus } from '../../application/ports/picture-suggestion.store';

/** `GET /admin/catalog/picture-suggestions` (Work 151): waiting ones by default, oldest first. */
export class ListPictureSuggestionsQueryDto {
  @IsOptional()
  @IsIn(PICTURE_SUGGESTION_STATUSES as PictureSuggestionStatus[])
  status?: PictureSuggestionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number;
}

/** `POST /admin/catalog/picture-suggestions/:id/reject` (Work 151): the pharmacy sees the reason. */
export class RejectPictureSuggestionDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(PICTURE_REJECT_REASON_MIN)
  @MaxLength(PICTURE_REJECT_REASON_MAX)
  reason!: string;
}
