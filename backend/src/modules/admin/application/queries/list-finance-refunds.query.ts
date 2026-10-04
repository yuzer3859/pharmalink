import { Inject, Injectable } from '@nestjs/common';
import {
  FINANCE_OVERSIGHT_PORT,
  FinanceRefundPage,
  IFinanceOversightPort,
  RefundDestination,
  RefundSearchCriteria,
  RefundStatus,
  RefundType,
} from '../../../payment/application/ports/inbound/finance-oversight.port';
import { financePaging } from './list-finance-payments.query';

export interface ListFinanceRefundsInput {
  status?: RefundStatus;
  type?: RefundType;
  destination?: RefundDestination;
  paymentId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  page?: number;
  size?: number;
}

/**
 * `GET /admin/finance/refunds` — every refund Module 07 holds, across every payment, newest
 * first. Module 07's own list (`GET /payments/{id}/refunds`) is one payment's refunds in the
 * order they were made; this is the desk's view across all of them, and the only new thing about
 * it is the population. The rows are Module 07's projection, with the approver.
 */
@Injectable()
export class ListFinanceRefundsQuery {
  constructor(@Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort) {}

  execute(input: ListFinanceRefundsInput): Promise<FinanceRefundPage> {
    const { page, size } = financePaging(input);
    const criteria: RefundSearchCriteria = {
      status: input.status,
      type: input.type,
      destination: input.destination,
      paymentId: input.paymentId,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.finance.listRefunds(criteria, page, size);
  }
}
