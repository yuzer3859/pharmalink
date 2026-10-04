import { Inject, Injectable } from '@nestjs/common';
import {
  COD_FINANCE_READ_PORT,
  CodCollectionSummary,
  ICodFinanceReadPort,
} from '../../../delivery/application/ports/inbound/cod-finance-read.port';
import {
  FINANCE_OVERSIGHT_PORT,
  IFinanceOversightPort,
  PaymentStatusTotals,
  RefundStatusTotals,
  SettlementStatusTotals,
} from '../../../payment/application/ports/inbound/finance-oversight.port';

/**
 * Four kinds of money, from two owners, side by side and never added together.
 *
 * | Section | Owner | What it is |
 * | --- | --- | --- |
 * | `payments` | Module 07 | what customers paid through a gateway, by payment status |
 * | `refunds` | Module 07 | what went (or is going) back to customers, by refund status |
 * | `settlements` | Module 07 | what statements say pharmacies are owed, by statement status |
 * | `cod` | Module 08 | cash drivers declared, handed over, and are still holding |
 *
 * The business model (Customer → Driver → PharmaLink → Pharmacy) is why the sections must stay
 * apart. A driver's collected cash is money in transit to PharmaLink, not PharmaLink's revenue
 * and not a pharmacy's payout; a pharmacy's payout is what a Module 07 statement derives from the
 * ledger, not what was captured; and a captured payment is a gross figure that a refund in the
 * next section may since have reversed. Each figure means exactly what its owner says it means,
 * and no figure here means anything its owner did not define.
 */
export interface FinanceOverviewView {
  /** When the reads were taken. They are not one snapshot; each is consistent with itself. */
  generatedAt: Date;
  payments: PaymentStatusTotals[];
  refunds: RefundStatusTotals[];
  settlements: SettlementStatusTotals[];
  cod: CodCollectionSummary;
}

/**
 * `GET /admin/finance/overview` (module-16 §9.6, F-AD-19) — the control-plane summary of the
 * financial state the marketplace has already produced.
 *
 * It computes nothing. Every number is a `COUNT` or a `Σ` of a stored column, grouped by a stored
 * status, done by the owning module's repository and handed over through a read port. There is
 * deliberately no GMV, no revenue, no margin and no "net position": those are accounting
 * conclusions the owning modules have not defined (Module 07 lists §9.6's finance report as a
 * later task), and a control plane that defined them itself would be keeping a third set of books.
 */
@Injectable()
export class GetFinanceOverviewQuery {
  constructor(
    @Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort,
    @Inject(COD_FINANCE_READ_PORT) private readonly cod: ICodFinanceReadPort,
  ) {}

  async execute(): Promise<FinanceOverviewView> {
    const [totals, cod] = await Promise.all([
      this.finance.totals(),
      this.cod.summarizeCollections(),
    ]);
    return {
      generatedAt: new Date(),
      payments: totals.payments,
      refunds: totals.refunds,
      settlements: totals.settlements,
      cod,
    };
  }
}
