import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { DevicePlatform } from '../../domain/enums';

export class DeviceInfoDto {
  @IsString()
  @MinLength(4)
  fingerprint!: string;

  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  fcmToken?: string;
}

/** Mixin for DTOs that carry an optional nested device (auto-login on OTP verify). */
export class OptionalDeviceInfoMixin {
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  deviceInfo?: DeviceInfoDto;
}
