import { PaymentProps } from '../domain/entities/payment.entity';
import { RefundProps } from '../domain/entities/refund.entity';
import {
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
  SettlementStatus,
} from '../domain/enums';
import { IPaymentRepository } from '../domain/repositories/payment.repository';
import { IRefundRepository } from '../domain/repositories/refund.repository';
import { ISettlementRepository } from '../domain/repositories/settlement.repository';
import { FinanceOversightPortAdapter } from './ports/inbound/finance-oversight.port';
import { ListPaymentRefundsQuery, PaymentRefundsView } from './queries/list-payment-refunds.query';

/**
 * `FinanceOversightPortAdapter` (module-16 Work 07's seam into this module). What is claimed
 * here is the *projection*: that nothing crosses the port which `PaymentView`/`RefundView` keep
 * back, and that what does cross is the repositories' own figures, unchanged. The repositories'
 * queries themselves are proved against PostgreSQL in `test/admin/admin-finance.e2e-spec.ts`.
 */
describe('FinanceOversightPortAdapter', () => {
  const NOW = new Date('2026-09-17T12:00:00.000Z');

  function payment(overrides: Partial<PaymentProps> = {}): PaymentProps {
    return {
      id: 'pay-1',
      orderId: 'ord-1',
      customerUserId: 'cust-1',
      method: PaymentMethod.TELEBIRR,
      status: PaymentStatus.CAPTURED,
      amount: 10_000,
      currency: 'ETB',
      originalAmount: null,
      originalCurrency: null,
      fxRate: null,
      fxSource: null,
      provider: 'mock',
      providerRef: 'mock-ref-1',
      providerToken: 'tok_SECRET',
      idempotencyKey: 'idem-SECRET',
      authorizedAt: NOW,
      capturedAt: NOW,
      failureReason: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function refund(overrides: Partial<RefundProps> = {}): RefundProps {
    return {
      id: 'ref-1',
      paymentId: 'pay-1',
      amount: 2_500,
      reason: 'partial dispute',
      type: RefundType.PARTIAL,
      destination: RefundDestination.ORIGINAL,
      status: RefundStatus.COMPLETED,
      providerRef: 'mock-refund-1',
      approvedBy: 'finance-1',
      idempotencyKey: 'refund-idem-SECRET',
      createdAt: NOW,
      completedAt: NOW,
      ...overrides,
    };
  }

  let payments: jest.Mocked<Pick<IPaymentRepository, 'search' | 'findById' | 'summarizeByStatus'>>;
  let refunds: jest.Mocked<Pick<IRefundRepository, 'search' | 'summarizeByStatus'>>;
  let settlements: jest.Mocked<Pick<ISettlementRepository, 'summarizeByStatus'>>;
  let listRefunds: jest.Mocked<Pick<ListPaymentRefundsQuery, 'execute'>>;
  let adapter: FinanceOversightPortAdapter;

  beforeEach(() => {
    payments = { search: jest.fn(), findById: jest.fn(), summarizeByStatus: jest.fn() };
    refunds = { search: jest.fn(), summarizeByStatus: jest.fn() };
    settlements = { summarizeByStatus: jest.fn() };
    listRefunds = { execute: jest.fn() };
    adapter = new FinanceOversightPortAdapter(
      payments as unknown as IPaymentRepository,
      refunds as unknown as IRefundRepository,
      settlements as unknown as ISettlementRepository,
      listRefunds as unknown as ListPaymentRefundsQuery,
    );
  });

  it('lists payments with the payer and the cross-border originals, and without the token or the key', async () => {
    payments.search.mockResolvedValue({ items: [payment()], total: 1, page: 2, size: 10 });

    const page = await adapter.listPayments({ status: PaymentStatus.CAPTURED }, 2, 10);

    expect(payments.search).toHaveBeenCalledWith({ status: PaymentStatus.CAPTURED }, 2, 10);
    expect(page).toEqual({
      items: [
        {
          paymentId: 'pay-1',
          orderId: 'ord-1',
          customerUserId: 'cust-1',
          amount: 10_000,
          currency: 'ETB',
          method: PaymentMethod.TELEBIRR,
          status: PaymentStatus.CAPTURED,
          provider: 'mock',
          providerRef: 'mock-ref-1',
          originalAmount: null,
          originalCurrency: null,
          fxRate: null,
          fxSource: null,
          authorizedAt: NOW,
          capturedAt: NOW,
          failureReason: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      total: 1,
      page: 2,
      size: 10,
    });
    expect(JSON.stringify(page)).not.toContain('SECRET');
  });

  it('answers null for an unknown payment without consulting the refund query', async () => {
    payments.findById.mockResolvedValue(null);
    await expect(adapter.getPayment('missing')).resolves.toBeNull();
    expect(listRefunds.execute).not.toHaveBeenCalled();
  });

  it('reads a payment with §9.3 refund view, unscoped', async () => {
    payments.findById.mockResolvedValue(payment());
    const view: PaymentRefundsView = {
      paymentId: 'pay-1',
      currency: 'ETB',
      capturedAmount: 10_000,
      totalRefunded: 2_500,
      remainingRefundable: 7_500,
      refunds: [],
    };
    listRefunds.execute.mockResolvedValue(view);

    const detail = await adapter.getPayment('pay-1');

    expect(listRefunds.execute).toHaveBeenCalledWith({ paymentId: 'pay-1' });
    expect(detail?.payment.paymentId).toBe('pay-1');
    expect(detail?.refunds).toBe(view);
  });

  it('lists refunds in the payment currency, with the approver and without the key', async () => {
    refunds.search.mockResolvedValue({
      items: [{ refund: refund(), currency: 'ETB' }],
      total: 1,
      page: 1,
      size: 20,
    });

    const page = await adapter.listRefunds({ status: RefundStatus.COMPLETED }, 1, 20);

    expect(refunds.search).toHaveBeenCalledWith({ status: RefundStatus.COMPLETED }, 1, 20);
    expect(page.items[0]).toEqual({
      refundId: 'ref-1',
      paymentId: 'pay-1',
      amount: 2_500,
      currency: 'ETB',
      type: RefundType.PARTIAL,
      destination: RefundDestination.ORIGINAL,
      status: RefundStatus.COMPLETED,
      providerRef: 'mock-refund-1',
      reason: 'partial dispute',
      approvedBy: 'finance-1',
      createdAt: NOW,
      completedAt: NOW,
    });
    expect(JSON.stringify(page)).not.toContain('SECRET');
  });

  it('hands the three summaries over unchanged and apart', async () => {
    const p = [{ currency: 'ETB', status: PaymentStatus.CAPTURED, count: 2, amount: 20_000 }];
    const r = [{ currency: 'ETB', status: RefundStatus.COMPLETED, count: 1, amount: 2_500 }];
    const s = [
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
    ];
    payments.summarizeByStatus.mockResolvedValue(p);
    refunds.summarizeByStatus.mockResolvedValue(r);
    settlements.summarizeByStatus.mockResolvedValue(s);

    await expect(adapter.totals()).resolves.toEqual({ payments: p, refunds: r, settlements: s });
  });
});
