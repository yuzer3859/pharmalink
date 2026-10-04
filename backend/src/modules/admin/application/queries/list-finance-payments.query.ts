import { Inject, Injectable } from '@nestjs/common';
import {
  FINANCE_OVERSIGHT_PORT,
  FinancePaymentPage,
  IFinanceOversightPort,
  PaymentMethod,
  PaymentSearchCriteria,
  PaymentStatus,
} from '../../../payment/application/ports/inbound/finance-oversight.port';

export const DEFAULT_FINANCE_PAGE = 1;
export const DEFAULT_FINANCE_PAGE_SIZE = 20;
export const MAX_FINANCE_PAGE_SIZE = 100;

export interface ListFinancePaymentsInput {
  status?: PaymentStatus;
  method?: PaymentMethod;
  provider?: string;
  orderId?: string;
  customerUserId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  page?: number;
  size?: number;
}

/**
 * The one pager every Work 07 list shares: a positive integer page, a size clamped to
 * `MAX_FINANCE_PAGE_SIZE`, and the defaults for anything else. The DTOs already reject bad
 * values with `400`; this is the application-level clamp behind them, so an in-process caller
 * gets the same bounds an HTTP caller does.
 */
export function financePaging(input: { page?: number; size?: number }): { page: number; size: number } {
  const page =
    input.page !== undefined && Number.isFinite(input.page) && input.page > 0
      ? Math.floor(input.page)
      : DEFAULT_FINANCE_PAGE;
  const size =
    input.size !== undefined && Number.isFinite(input.size) && input.size > 0
      ? Math.min(Math.floor(input.size), MAX_FINANCE_PAGE_SIZE)
      : DEFAULT_FINANCE_PAGE_SIZE;
  return { page, size };
}

/**
 * `GET /admin/finance/payments` (module-16 §9.6, F-AD-19) — every payment Module 07 holds,
 * across every customer, newest first.
 *
 * Nothing here is Module 16's data and nothing here is computed. The rows come through
 * `IFinanceOversightPort` already projected — no gateway token, no idempotency key — and this
 * query forwards the column filters and the pager and adds nothing. No status is assumed by
 * default: a queue of stuck `INITIATED` payments and the history of `CAPTURED` ones are each one
 * filter away, and neither is the "real" list.
 */
@Injectable()
export class ListFinancePaymentsQuery {
  constructor(@Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort) {}

  execute(input: ListFinancePaymentsInput): Promise<FinancePaymentPage> {
    const { page, size } = financePaging(input);
    const criteria: PaymentSearchCriteria = {
      status: input.status,
      method: input.method,
      provider: input.provider,
      orderId: input.orderId,
      customerUserId: input.customerUserId,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.finance.listPayments(criteria, page, size);
  }
}
