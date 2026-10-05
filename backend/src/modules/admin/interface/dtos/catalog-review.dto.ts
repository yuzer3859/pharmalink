import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  ProductStatus,
  ProductType,
} from '../../../catalog/application/ports/inbound/catalog-admin-read.port';
import { MAX_CATALOG_REVIEW_PAGE_SIZE } from '../../application/queries/list-catalog-review.query';

/** `GET /admin/catalog/review` query string. Every filter is one Module 03 can answer. */
export class ListCatalogReviewQueryDto {
  /** Any `ProductStatus` Module 03 defines; `DRAFT` when omitted. */
  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @IsEnum(ProductType)
  @IsOptional()
  type?: ProductType;

  /** Substring of a product name, as the public search takes it. Bounded so it cannot be a payload. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  q?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_CATALOG_REVIEW_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
