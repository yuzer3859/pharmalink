import { PartialType } from '@nestjs/mapped-types';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { MANUFACTURER_STATUS_ALLOWLIST } from '../../domain/enums';

/** `POST /admin/catalog/manufacturers` (module-03 §4.4). */
export class CreateManufacturerDto {
  @IsString()
  @Length(2, 150)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  country?: string;
}

/** `PATCH /admin/catalog/manufacturers/:id`. */
export class UpdateManufacturerDto extends PartialType(CreateManufacturerDto) {
  @IsOptional()
  @IsIn(MANUFACTURER_STATUS_ALLOWLIST)
  status?: string;
}
