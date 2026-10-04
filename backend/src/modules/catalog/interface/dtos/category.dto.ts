import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Min } from 'class-validator';
import { CATEGORY_SLUG_REGEX } from '../../domain/enums';

/** `POST /admin/catalog/categories` (module-03 §4.3). */
export class CreateCategoryDto {
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsString()
  @Matches(CATEGORY_SLUG_REGEX)
  slug!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  nameAm?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  nameEn?: string;

  @IsOptional()
  @IsIn(['MEDICINE', 'HEALTH_PRODUCT', 'BOTH'])
  appliesTo?: string = 'BOTH';

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/** `PATCH /admin/catalog/categories/:id` — `slug` immutable after create, omitted (§3.2). */
export class UpdateCategoryDto extends PartialType(OmitType(CreateCategoryDto, ['slug'] as const)) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
