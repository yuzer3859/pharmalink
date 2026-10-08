import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DeliveryQueueStatus } from '../../../notifications/application/ports/inbound/notification-delivery-admin.port';
import { MAX_DELIVERY_JOB_PAGE_SIZE } from '../../application/queries/delivery-queue.queries';

/** The channels that have delivery jobs — `IN_APP` never does. */
export const DELIVERY_JOB_CHANNELS = ['PUSH', 'SMS', 'EMAIL'] as const;

/**
 * `GET /admin/notifications/delivery` filters — stored job columns only. No recipient, content,
 * provider or free-text filter exists.
 */
export class ListDeliveryJobsQueryDto {
  @IsIn(DELIVERY_JOB_CHANNELS)
  @IsOptional()
  channel?: (typeof DELIVERY_JOB_CHANNELS)[number];

  @IsEnum(DeliveryQueueStatus)
  @IsOptional()
  status?: DeliveryQueueStatus;

  @IsUUID()
  @IsOptional()
  notificationId?: string;

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  @IsDateString()
  @IsOptional()
  nextAttemptFrom?: string;

  @IsDateString()
  @IsOptional()
  nextAttemptTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_DELIVERY_JOB_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
