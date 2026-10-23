import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_CANCELLATION_OPERATIONS_PAGE_SIZE } from '../../application/queries/order-cancellation-operations.queries';

/** `GET /admin/operations/order-cancellations` query string. */
export class ListOrderCancellationOperationsQueryDto {
  @IsIn(['PENDING', 'ATTENTION'])
  @IsOptional()
  state?: 'PENDING' | 'ATTENTION';

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_CANCELLATION_OPERATIONS_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
