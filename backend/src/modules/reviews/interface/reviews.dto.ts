import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_BODY_LENGTH, MAX_REPORT_DETAIL_LENGTH, MAX_TITLE_LENGTH, REPORT_REASONS, ReportReason } from '../domain/review-policy';

export class ReviewContentDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsString()
  @MaxLength(MAX_TITLE_LENGTH)
  @IsOptional()
  title?: string;

  @IsString()
  @MaxLength(MAX_BODY_LENGTH)
  @IsOptional()
  body?: string;
}

/** `POST /reviews`. The author is the token's principal; the subject comes from the order. */
export class SubmitReviewDto extends ReviewContentDto {
  @IsUUID()
  orderId!: string;

  /** Only when the order was fulfilled by more than one pharmacy. */
  @IsUUID()
  @IsOptional()
  pharmacyId?: string;
}

export class ReportReviewDto {
  @IsIn(REPORT_REASONS)
  reason!: ReportReason;

  @IsString()
  @MaxLength(MAX_REPORT_DETAIL_LENGTH)
  @IsOptional()
  detail?: string;
}

export class PageQueryDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  size?: number;
}
