import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import {
  CodDisputeStatus,
  MAX_COD_DISPUTE_NOTE_LENGTH,
} from '../../../delivery/application/ports/inbound/cod-dispute-admin.port';
import { MAX_COD_DISPUTE_PAGE_SIZE } from '../../application/queries/list-cod-disputes.query';

/**
 * `GET /admin/cod-disputes` query string. Every filter is a column of `cod_disputes` or of the
 * collection it hangs off; none searches the free-text reason or note.
 */
export class ListCodDisputesQueryDto {
  @IsEnum(CodDisputeStatus)
  @IsOptional()
  status?: CodDisputeStatus;

  @IsUUID()
  @IsOptional()
  collectionId?: string;

  /** `driver_profiles.id`, as Module 08's own finance filters take it. */
  @IsUUID()
  @IsOptional()
  driverId?: string;

  @IsUUID()
  @IsOptional()
  jobId?: string;

  @IsUUID()
  @IsOptional()
  orderId?: string;

  @IsDateString()
  @IsOptional()
  openedFrom?: string;

  @IsDateString()
  @IsOptional()
  openedTo?: string;

  @IsDateString()
  @IsOptional()
  resolvedFrom?: string;

  @IsDateString()
  @IsOptional()
  resolvedTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_COD_DISPUTE_PAGE_SIZE)
  @IsOptional()
  size?: number;
}

/**
 * `POST /admin/cod-disputes/:id/resolve`. Exactly what Module 08's own `ResolveCodDisputeDto`
 * takes: a free-text note, optional, same bound. **No actor, no outcome, no amount, no status** —
 * Module 08 has no outcome enum (a decision, see `CodDispute`), moves no money on resolution,
 * and the resolver is the authenticated principal. A body naming any of those is rejected by
 * `forbidNonWhitelisted` rather than ignored.
 */
export class ResolveCodDisputeDto {
  @IsString()
  @MaxLength(MAX_COD_DISPUTE_NOTE_LENGTH)
  @IsOptional()
  resolutionNote?: string;
}
