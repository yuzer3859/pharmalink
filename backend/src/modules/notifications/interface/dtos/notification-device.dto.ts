import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DEVICE_PLATFORMS, DevicePlatform } from '../../domain/repositories/device-token.repository';

/**
 * `POST /notification-devices` body: the app install's FCM registration token and its platform —
 * the only two things `device_tokens` stores from a client. No owner field of any kind:
 * `forbidNonWhitelisted` rejects `userId`, `actorUserId`, `isActive` and anything else.
 */
export class RegisterDeviceTokenDto {
  /**
   * Printable ASCII, no spaces — FCM tokens are URL-safe base64 with `:` / `-` / `_`. Read raw from
   * the body: the global pipe's implicit conversion would otherwise stringify a JSON number.
   */
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.token)
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  @Matches(/^[\x21-\x7E]+$/, { message: 'token must be printable ASCII without spaces' })
  token!: string;

  @IsIn(DEVICE_PLATFORMS)
  platform!: DevicePlatform;
}
