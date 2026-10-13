import { IsDateString, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CodCollectionStatus } from '../../../delivery/application/ports/inbound/cod-operations-read.port';
import { MAX_COD_OPERATIONS_PAGE_SIZE } from '../../application/queries/cod-operations.queries';

/**
 * `GET /admin/operations/cod` query string. Every filter is a column of `cod_collections`, matched
 * exactly or as a `collectedAt` window (inclusive, Module 08's own period filter). No free-text search.
 */
export class ListCodOperationsQueryDto {
  /** Module 08's own `CodCollectionStatus`. */
  @IsEnum(CodCollectionStatus)
  @IsOptional()
  status?: CodCollectionStatus;

  @IsUUID()
  @IsOptional()
  orderId?: string;

  /** The delivery job the collection was taken on. */
  @IsUUID()
  @IsOptional()
  jobId?: string;

  @IsDateString()
  @IsOptional()
  collectedFrom?: string;

  @IsDateString()
  @IsOptional()
  collectedTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_COD_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
