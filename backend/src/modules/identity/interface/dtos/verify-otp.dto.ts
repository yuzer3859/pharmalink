import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { OtpPurpose } from '../../domain/enums';
import { DeviceInfoDto } from './device-info.dto';

export class VerifyOtpDto {
  @IsString()
  identifier!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsEnum(OtpPurpose)
  purpose!: OtpPurpose;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  deviceInfo?: DeviceInfoDto;
}

export class ResendOtpDto {
  @IsString()
  identifier!: string;

  @IsEnum(OtpPurpose)
  purpose!: OtpPurpose;
}
