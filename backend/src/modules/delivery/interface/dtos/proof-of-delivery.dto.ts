import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MAX_RECIPIENT_NAME_LENGTH } from '../../domain/entities/proof-of-delivery.entity';
import { PodType } from '../../domain/enums';

/**
 * The base64 payload of a signature or a photograph.
 *
 * Nested rather than flattened so that "there is an artifact" is a single presence check rather
 * than a rule about which of two loose fields imply each other, and so `@ValidateNested` refuses a
 * content type with no bytes and bytes with no content type as one decision.
 *
 * The size ceiling is **not** here. It is enforced in `CaptureProofOfDeliveryCommand` against the
 * *decoded* length, because the cap is a statement about how many bytes the platform will keep and
 * base64 inflates by a third — a `MaxLength` on this string would be a cap on the wrong number,
 * and it would also be a business rule sitting in a DTO where configuration cannot reach it.
 */
export class ProofArtifactDto {
  /**
   * Checked against the command's allow-list, not with `@IsIn` here.
   *
   * The list is a security boundary and belongs beside the code that decodes and stores the bytes,
   * where it cannot be satisfied by a request that never reaches the command.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contentType!: string;

  /** Never logged, never echoed, never persisted in a row — see the capture command. */
  @IsString()
  @IsNotEmpty()
  contentBase64!: string;
}

/**
 * `POST /delivery/jobs/{id}/proof-of-delivery` — the body, and **only** the body.
 *
 * There is deliberately no `driverId` and no `jobId`: the delivery comes from the path and the
 * driver from the access token, so §8's "do not trust a client-supplied driver ID" is satisfied
 * structurally — there is no field through which such a claim could arrive, and
 * `forbidNonWhitelisted` turns sending one into a `400` rather than a silently ignored extra.
 *
 * There is no `capturedAt` either. Evidence that the client could backdate is not evidence; the
 * capture time is the server's.
 */
export class CaptureProofOfDeliveryDto {
  @IsEnum(PodType)
  type!: PodType;

  /**
   * Who took delivery, as the driver records it.
   *
   * A free-text note, and it is worth being clear that the platform does not verify it: the driver
   * is writing down the name the person at the door gave. §4 is explicit that OTP or signature
   * *verification* is not to be invented here, and presenting an unverified name as a verified
   * identity would be exactly that. It is a record of what the driver was told.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_RECIPIENT_NAME_LENGTH)
  recipientName?: string;

  /** The recipient's attestation that they received the order. Required, and never defaulted. */
  @IsBoolean()
  recipientConfirmed!: boolean;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ProofArtifactDto)
  artifact?: ProofArtifactDto;
}
