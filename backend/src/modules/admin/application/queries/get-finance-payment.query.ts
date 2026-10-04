import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import {
  FINANCE_OVERSIGHT_PORT,
  FinancePaymentDetailView,
  IFinanceOversightPort,
} from '../../../payment/application/ports/inbound/finance-oversight.port';

/**
 * `GET /admin/finance/payments/:id` — one payment with §9.3's refund view beside it: every
 * refund against it, the total refunded and what may still be refunded. All of it is Module 07's
 * own projection; this query adds nothing and joins nothing.
 */
@Injectable()
export class GetFinancePaymentQuery {
  constructor(@Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort) {}

  async execute(paymentId: string): Promise<FinancePaymentDetailView> {
    const view = await this.finance.getPayment(paymentId);
    if (!view) {
      throw ApiException.notFound('Payment not found.');
    }
    return view;
  }
}
