import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, MAX_SUGGESTIONS } from '../application/search-query.service';

class GeoQueryDto {
  /** Latitude and longitude come together; either alone is refused by the controller. */
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(MAX_RADIUS_KM)
  radiusKm?: number = DEFAULT_RADIUS_KM;
}

export class SearchMedicinesQueryDto extends GeoQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(['RX', 'OTC'])
  rx?: 'RX' | 'OTC';

  /** `true` keeps only products purchasable now (within the radius, with a location). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  availableOnly?: boolean;

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

export class SearchOffersQueryDto extends GeoQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class SearchPharmaciesQueryDto extends GeoQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

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

/** Work 158: suggestions while typing. */
export class SearchSuggestQueryDto {
  @IsString()
  @MaxLength(60)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_SUGGESTIONS)
  limit?: number = 8;
}

/** Work 158: the most made searches this week. */
export class SearchTrendingQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 10;
}

/** Work 162: `GET /search/providers`. */
export class SearchProvidersQueryDto extends GeoQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsIn(['HOSPITAL', 'CLINIC', 'DIAGNOSTIC_CENTER', 'LAB'])
  type?: 'HOSPITAL' | 'CLINIC' | 'DIAGNOSTIC_CENTER' | 'LAB';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string;

  @IsOptional()
  @IsIn(['LAB_TEST', 'IMAGING', 'SCREENING_PACKAGE'])
  serviceType?: 'LAB_TEST' | 'IMAGING' | 'SCREENING_PACKAGE';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  emergency?: boolean;

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

/** Work 162: `GET /search/services`. */
export class SearchServicesQueryDto extends GeoQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsIn(['LAB_TEST', 'IMAGING', 'SCREENING_PACKAGE'])
  serviceType?: 'LAB_TEST' | 'IMAGING' | 'SCREENING_PACKAGE';

  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  city?: string;

  @IsOptional()
  @IsIn(['relevance', 'price', 'distance'])
  sort?: 'relevance' | 'price' | 'distance';

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

/** Work 167: `GET /search/doctors`. */
export class SearchDoctorsQueryDto extends GeoQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  telemedicine?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  availableOnly?: boolean;

  @IsOptional()
  @IsIn(['next_available', 'rating', 'distance'])
  sort?: 'next_available' | 'rating' | 'distance';

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
