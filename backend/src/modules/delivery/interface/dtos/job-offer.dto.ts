import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_OFFER_REASON_LENGTH } from '../../domain/entities/job-offer.entity';

/**
 * `POST /delivery/jobs/{id}/decline` (§9.2) — the body, and **only** the body.
 *
 * One optional field. There is deliberately no `offerId`: which offer the driver is declining is
 * resolved from the job in the path and the driver in the access token, so a client cannot name
 * somebody else's offer even by accident. There is no `driverId` either, for the same reason —
 * `forbidNonWhitelisted` turns sending one into a `400` rather than a silently ignored extra.
 */
export class DeclineJobOfferDto {
  @IsOptional()
  @IsString()
  @MaxLength(MAX_OFFER_REASON_LENGTH)
  reason?: string;
}

/**
 * The optional body a driver may attach to a status post (§9.2).
 *
 * Coordinates are where the driver was *when the event happened* (§13's "with geo"); omitted, the
 * command falls back to the profile's last-known position. They are **recorded on the transition
 * only** — this is not a location-reporting channel, and nothing here is published or streamed.
 *
 * There is deliberately no `status` field: the target status comes from the route, so a client
 * cannot post to `/picked-up` and ask for `DELIVERED`.
 */
export class DeliveryStatusUpdateDto {
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}

/** `POST /delivery/jobs/{id}/fail` (§9.2) — the reason is required, not decorative. */
export class FailDeliveryJobDto extends DeliveryStatusUpdateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_OFFER_REASON_LENGTH)
  reason!: string;
}
