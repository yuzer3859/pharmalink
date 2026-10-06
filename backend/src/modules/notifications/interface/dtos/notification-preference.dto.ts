import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { DigestFrequency } from '../../domain/enums';
import {
  CONFIGURABLE_CATEGORIES,
  CONFIGURABLE_CHANNELS,
  ConfigurableCategory,
  ConfigurableChannel,
} from '../../domain/preferences';

/** `:category` — only the configurable categories; anything else (`MARKETING`, `foo`) is `400`. */
export class NotificationPreferenceCategoryParamDto {
  @IsIn(CONFIGURABLE_CATEGORIES)
  category!: ConfigurableCategory;
}

export class ChannelPreferenceChangeDto {
  /** `PUSH`, `SMS` or `EMAIL`. `IN_APP` is fixed by policy and refused. */
  @IsIn(CONFIGURABLE_CHANNELS)
  channel!: ConfigurableChannel;

  /**
   * The raw JSON value, read from the source object: the global pipe's implicit conversion would
   * otherwise turn the string `"false"` into `true` (`Boolean("false")`). Only a real boolean passes.
   */
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.enabled)
  @IsBoolean()
  enabled!: boolean;

  @IsEnum(DigestFrequency)
  @IsOptional()
  digestFrequency?: DigestFrequency;
}

/**
 * `PUT /notification-preferences/:category` body. No owner field of any kind: the preferences are
 * always the authenticated principal's, and `forbidNonWhitelisted` rejects a `userId`,
 * `actorUserId`, `id` or any other key a client adds — at this level and inside each channel.
 */
export class UpdateNotificationPreferencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CONFIGURABLE_CHANNELS.length)
  @ArrayUnique((c: ChannelPreferenceChangeDto) => c?.channel)
  @ValidateNested({ each: true })
  @Type(() => ChannelPreferenceChangeDto)
  channels!: ChannelPreferenceChangeDto[];
}
