import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

export class LoginDto {
  @IsString()
  identifier!: string;

  @IsString()
  password!: string;

  @ValidateNested()
  @Type(() => DeviceInfoDto)
  deviceInfo!: DeviceInfoDto;
}
