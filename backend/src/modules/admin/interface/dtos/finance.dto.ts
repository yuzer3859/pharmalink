import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
} from '../../../payment/application/ports/inbound/finance-oversight.port';
import { MAX_FINANCE_PAGE_SIZE } from '../../application/queries/list-finance-payments.query';

/** Gateway keys are short lowercase handles (`mock`, `telebirr`); anything else is not a filter. */
const PROVIDER_KEY = /^[a-z0-9_-]+$/;
const MAX_PROVIDER_LENGTH = 32;

/**
 * `GET /admin/finance/payments` query string. Every filter is a column of `payments`; none is a
 * derived attribute, none searches free text, and none is an expression — a value is matched
 * exactly or a window is applied, and that is the whole filter language.
 */
export class ListFinancePaymentsQueryDto {
  @IsEnum(PaymentStatus)
  @IsOptional()
  status?: PaymentStatus;

  @IsEnum(PaymentMethod)
  @IsOptional()
  method?: PaymentMethod;

  @Matches(PROVIDER_KEY)
  @MaxLength(MAX_PROVIDER_LENGTH)
  @IsOptional()
  provider?: string;

  @IsUUID()
  @IsOptional()
  orderId?: string;

  /** Module 01 `users.id` of the payer, as `payments.customerUserId` stores it. */
  @IsUUID()
  @IsOptional()
  customerUserId?: string;

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_FINANCE_PAGE_SIZE)
  @IsOptional()
  size?: number;
}

/** `GET /admin/finance/refunds` query string. Columns of `refunds` only; the reason is not searched. */
export class ListFinanceRefundsQueryDto {
  @IsEnum(RefundStatus)
  @IsOptional()
  status?: RefundStatus;

  @IsEnum(RefundType)
  @IsOptional()
  type?: RefundType;

  @IsEnum(RefundDestination)
  @IsOptional()
  destination?: RefundDestination;

  @IsUUID()
  @IsOptional()
  paymentId?: string;

  @IsDateString()
  @IsOptional()
  createdFrom?: string;

  @IsDateString()
  @IsOptional()
  createdTo?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @IsInt()
  @Min(1)
  @Max(MAX_FINANCE_PAGE_SIZE)
  @IsOptional()
  size?: number;
}
