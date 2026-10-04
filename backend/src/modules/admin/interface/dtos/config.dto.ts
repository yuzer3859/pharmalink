import {
  IsBoolean,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ConfigValueType } from '../../domain/enums';
import { MAX_CONFIG_REASON_LENGTH } from '../../domain/entities/platform-config.entity';
import { MAX_FEATURE_FLAG_DESCRIPTION_LENGTH } from '../../domain/entities/feature-flag.entity';

/**
 * `PUT /admin/config/:namespace/:key` (module-16 §9.4).
 *
 * **There is no `updatedBy`, no `actorUserId` and no `version` field**, and each absence is load
 * bearing:
 *
 *  - The actor comes from the verified access token. With `forbidNonWhitelisted` on the global
 *    pipe, a request that sends one is rejected outright rather than having it quietly dropped —
 *    the difference between a field that is ignored and a field that does not exist.
 *  - The version is computed from what is already stored. A caller-supplied version would let two
 *    administrators both publish "version 4" with different values and no way to say which decision
 *    came second.
 *
 * The namespace and key come from the path, not the body, so the URL an audit entry records and the
 * row it wrote can never name different settings.
 */
export class UpdateConfigDto {
  /**
   * The declared type, which must match the catalogue's for this key.
   *
   * Required rather than inferred from the JSON. Inferring would silently accept `"30"` for an
   * integer key and store a string that every reader then has to coerce; making the caller state
   * the type turns that into an error at the boundary.
   */
  @IsEnum(ConfigValueType)
  valueType!: ConfigValueType;

  /**
   * The value. Typed by `valueType` and validated against the owning module's own bounds in
   * `ConfigValue.of` — `@IsDefined` is all that can be said about it here, because at this layer it
   * is legitimately a boolean, a number, a string or an object.
   *
   * `null` is not accepted: clearing an override is not the same operation as setting one and would
   * need its own route and its own semantics for what the version history should say.
   */
  @IsDefined()
  value!: unknown;

  /** Why the change is being made. Recorded on the version and in the audit entry. */
  @IsString()
  @MaxLength(MAX_CONFIG_REASON_LENGTH)
  @IsOptional()
  reason?: string;
}

/** `POST /admin/config/:namespace/:key/rollback` — §8 of the work brief. */
export class RollbackConfigDto {
  /** The historical version whose value should come back into force as a *new* version. */
  @IsInt()
  @Min(1)
  toVersion!: number;

  @IsString()
  @MaxLength(MAX_CONFIG_REASON_LENGTH)
  @IsOptional()
  reason?: string;
}

/**
 * `PUT /admin/feature-flags/:key`.
 *
 * The key is in the path; the body carries only what is being decided. As above, there is no actor
 * field.
 */
export class ToggleFeatureFlagDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @MaxLength(MAX_FEATURE_FLAG_DESCRIPTION_LENGTH)
  @IsOptional()
  description?: string;
}

/** `GET /admin/config?namespace=delivery`. */
export class ListConfigQueryDto {
  @IsString()
  @MaxLength(64)
  @IsOptional()
  namespace?: string;
}
