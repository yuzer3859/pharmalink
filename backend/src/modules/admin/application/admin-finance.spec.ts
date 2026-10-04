import { ErrorCode } from '../../../shared/errors/error-codes';
import { ICodFinanceReadPort } from '../../delivery/application/ports/inbound/cod-finance-read.port';
import {
  FinanceTotalsView,
  IFinanceOversightPort,
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
  SettlementStatus,
} from '../../payment/application/ports/inbound/finance-oversight.port';
import { GetFinanceOverviewQuery } from './queries/get-finance-overview.query';
import { GetFinancePaymentQuery } from './queries/get-finance-payment.query';
import {
  DEFAULT_FINANCE_PAGE_SIZE,
  ListFinancePaymentsQuery,
  MAX_FINANCE_PAGE_SIZE,
} from './queries/list-finance-payments.query';
import { ListFinanceRefundsQuery } from './queries/list-finance-refunds.query';

/**
 * Module 16 Work 07's application layer, with Modules 07 and 08 behind fake ports. The claims
 * here are about forwarding and about keeping the four kinds of money apart; what the figures
 * are is the owning modules' claim, made against PostgreSQL in
 * `test/admin/admin-finance.e2e-spec.ts`.
 */
describe('Admin finance oversight (application)', () => {
  let finance: jest.Mocked<IFinanceOversightPort>;
  let cod: jest.Mocked<ICodFinanceReadPort>;

  beforeEach(() => {
    finance = { listPayments: jest.fn(), getPayment: jest.fn(), listRefunds: jest.fn(), totals: jest.fn() };
    cod = { summarizeCollections: jest.fn() };
  });

  describe('ListFinancePaymentsQuery', () => {
    let query: ListFinancePaymentsQuery;

    beforeEach(() => {
      query = new ListFinancePaymentsQuery(finance);
      finance.listPayments.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 });
    });

    it('forwards every column filter Module 07 supports and no default status', async () => {
      const from = new Date('2026-09-01T00:00:00.000Z');
      await query.execute({
        status: PaymentStatus.CAPTURED,
        method: PaymentMethod.TELEBIRR,
        provider: 'mock',
        orderId: 'ord-1',
        customerUserId: 'cust-1',
        createdFrom: from,
      });
      expect(finance.listPayments).toHaveBeenCalledWith(
        {
          status: PaymentStatus.CAPTURED,
          method: PaymentMethod.TELEBIRR,
          provider: 'mock',
          orderId: 'ord-1',
          customerUserId: 'cust-1',
          createdFrom: from,
          createdTo: undefined,
        },
        1,
        DEFAULT_FINANCE_PAGE_SIZE,
      );
      await query.execute({});
      expect(finance.listPayments.mock.calls[1][0].status).toBeUndefined();
    });

    it('clamps the page size and floors a fractional page; defaults for non-positive values', async () => {
      await query.execute({ page: 4.2, size: 999 });
      expect(finance.listPayments).toHaveBeenCalledWith(expect.anything(), 4, MAX_FINANCE_PAGE_SIZE);
      await query.execute({ page: 0, size: -3 });
      expect(finance.listPayments).toHaveBeenCalledWith(expect.anything(), 1, DEFAULT_FINANCE_PAGE_SIZE);
    });
  });

  describe('GetFinancePaymentQuery', () => {
    it('answers NOT_FOUND for an unknown id', async () => {
      finance.getPayment.mockResolvedValue(null);
      await expect(new GetFinancePaymentQuery(finance).execute('missing')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('ListFinanceRefundsQuery', () => {
    it('forwards the refund column filters and the clamped pager', async () => {
      finance.listRefunds.mockResolvedValue({ items: [], total: 0, page: 1, size: 20 });
      const to = new Date('2026-09-30T00:00:00.000Z');
      await new ListFinanceRefundsQuery(finance).execute({
        status: RefundStatus.PENDING,
        type: RefundType.FULL,
        destination: RefundDestination.WALLET,
        paymentId: 'pay-1',
        createdTo: to,
        page: 3,
        size: 500,
      });
      expect(finance.listRefunds).toHaveBeenCalledWith(
        {
          status: RefundStatus.PENDING,
          type: RefundType.FULL,
          destination: RefundDestination.WALLET,
          paymentId: 'pay-1',
          createdFrom: undefined,
          createdTo: to,
        },
        3,
        MAX_FINANCE_PAGE_SIZE,
      );
    });
  });

  describe('GetFinanceOverviewQuery', () => {
    it('places each owner’s figures in its own section and adds nothing across them', async () => {
      const totals: FinanceTotalsView = {
        payments: [{ currency: 'ETB', status: PaymentStatus.CAPTURED, count: 2, amount: 20_000 }],
        refunds: [{ currency: 'ETB', status: RefundStatus.COMPLETED, count: 1, amount: 2_500 }],
        settlements: [
          {
            currency: 'ETB',
            status: SettlementStatus.DRAFT,
            count: 1,
            providerPayableGross: 9_000,
            refundClawback: 2_250,
            netPayable: 6_750,
            platformRevenue: 1_000,
            promotionExpense: 0,
            customerCashCollected: 10_000,
          },
        ],
      };
      const summary = {
        count: 1,
        expectedAmount: 24_500,
        collectedAmount: 20_000,
        remittedAmount: 0,
        outstandingCount: 1,
        outstandingAmount: 20_000,
        discrepancyCount: 1,
      };
      finance.totals.mockResolvedValue(totals);
      cod.summarizeCollections.mockResolvedValue(summary);

      const view = await new GetFinanceOverviewQuery(finance, cod).execute();

      expect(view.payments).toBe(totals.payments);
      expect(view.refunds).toBe(totals.refunds);
      expect(view.settlements).toBe(totals.settlements);
      expect(view.cod).toBe(summary);
      expect(view.generatedAt).toBeInstanceOf(Date);
      // The whole of the view is the four sections and the stamp: no grand total, no net, no GMV.
      expect(Object.keys(view).sort()).toEqual(['cod', 'generatedAt', 'payments', 'refunds', 'settlements']);
    });

    it('fails as a whole when either owner refuses, rather than answering a partial overview', async () => {
      finance.totals.mockResolvedValue({ payments: [], refunds: [], settlements: [] });
      cod.summarizeCollections.mockRejectedValue(new Error('cod unavailable'));
      await expect(new GetFinanceOverviewQuery(finance, cod).execute()).rejects.toThrow('cod unavailable');
    });
  });
});
