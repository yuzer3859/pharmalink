import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  ATC_CODE_REGEX,
  DOSAGE_FORM_ALLOWLIST,
  STRENGTH_UNIT_ALLOWLIST,
} from '../../domain/enums';

/** `POST /admin/catalog/products` (module-03 §4.1). Business validation (e.g. `rxClassification`
 * required for `MEDICINE`, `manufacturerId` required for `MEDICINE` per §3.6 invariant 8,
 * resolved §14.6) happens in `CreateProductCommand`, not here — same split as Module 02's DOB
 * rule. */
export class CreateProductDto {
  @IsIn(['MEDICINE', 'HEALTH_PRODUCT'])
  type!: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  genericName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  brandName?: string;

  @IsOptional()
  @IsUUID()
  manufacturerId?: string;

  @IsOptional()
  @IsIn(DOSAGE_FORM_ALLOWLIST)
  dosageForm?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  strengthValue?: number;

  @IsOptional()
  @IsIn(STRENGTH_UNIT_ALLOWLIST)
  strengthUnit?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  packSize?: string;

  @IsOptional()
  @Matches(ATC_CODE_REGEX)
  atcCode?: string;

  @IsOptional()
  @IsIn(['RX', 'OTC'])
  rxClassification?: string;

  @IsOptional()
  @IsIn(['NONE', 'SCHEDULE_1', 'SCHEDULE_2', 'SCHEDULE_3', 'SCHEDULE_4', 'SCHEDULE_5', 'PROHIBITED'])
  controlledSchedule?: string;

  @IsOptional()
  @IsIn(['AMBIENT', 'COLD_CHAIN', 'CONTROLLED_TEMP'])
  storageRequirement?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameAm?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  descriptionAm?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  descriptionEn?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  warnings?: string;

  /** Platform reference price in ETB **integer minor units** (`00-shared-conventions.md` §11 —
   * money is never a float), so `@IsInt()`, never `@IsNumber()`. Omitting it leaves the product
   * unpriced, which Module 06 treats as not purchasable rather than free. */
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  categoryIds?: string[];
}

/** `PATCH /admin/catalog/products/:id` — `type` immutable after create, omitted entirely
 * (`forbidNonWhitelisted` rejects any attempt to send it, §4.1). */
export class UpdateProductDto extends PartialType(OmitType(CreateProductDto, ['type'] as const)) {}

/** `POST /admin/catalog/products/:id/status` (module-03 §4.2). Transition legality is enforced
 * by the state machine (§3.6 invariant 6), not this DTO — `DRAFT` is only ever a legal *target*
 * from `DELISTED` (resolved by Architect review, §14.3). */
export class ChangeProductStatusDto {
  @IsIn(['ACTIVE', 'DEPRECATED', 'DELISTED', 'DRAFT'])
  status!: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  reason?: string;
}

/** `GET /catalog/products` (module-03 §4.5). Public reads only ever return `status = ACTIVE`
 * products — enforced in the query, not just here (§7.1). */
export class SearchProductsQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  @IsOptional()
  @IsIn(['MEDICINE', 'HEALTH_PRODUCT'])
  type?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(['RX', 'OTC'])
  rx?: string;

  @IsOptional()
  @IsUUID()
  manufacturerId?: string;

  @IsOptional()
  @IsIn(['relevance', 'name_asc', 'newest'])
  sort?: 'relevance' | 'name_asc' | 'newest' = 'relevance';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  size?: number = 20;
}
