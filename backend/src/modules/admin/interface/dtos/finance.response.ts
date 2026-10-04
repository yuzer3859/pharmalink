import { CodCollectionSummary } from '../../../delivery/application/ports/inbound/cod-finance-read.port';
import {
  FinancePaymentDetailView,
  FinancePaymentPage,
  FinancePaymentView,
  FinanceRefundPage,
  FinanceRefundView,
  PaymentRefundsView,
  PaymentStatusTotals,
  RefundStatusTotals,
  RefundView,
  SettlementStatusTotals,
} from '../../../payment/application/ports/inbound/finance-oversight.port';
import { FinanceOverviewView } from '../../application/queries/get-finance-overview.query';

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/**
 * A payment as the control plane reports it — Module 07's finance projection, field by field.
 * No gateway token, no idempotency key, no ledger internal, nothing from Module 01 (the payer
 * is a `users.id` and nothing more).
 */
export interface FinancePaymentResponse {
  paymentId: string;
  orderId: string;
  customerUserId: string;
  amount: number;
  currency: string;
  method: string;
  status: string;
  provider: string | null;
  providerRef: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
  fxSource: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancePaymentListResponse {
  items: FinancePaymentResponse[];
  total: number;
  page: number;
  size: number;
}

/** One refund inside a payment's detail — §9.3's `RefundView`, as Module 07 returns it. */
export interface FinancePaymentRefundResponse {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  type: string;
  destination: string;
  status: string;
  providerRef: string | null;
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** §9.3's `PaymentRefundsView`: the captured amount, what counts as refunded, and what remains. */
export interface FinancePaymentRefundsResponse {
  capturedAmount: number;
  totalRefunded: number;
  remainingRefundable: number;
  refunds: FinancePaymentRefundResponse[];
}

export interface FinancePaymentDetailResponse {
  payment: FinancePaymentResponse;
  refunds: FinancePaymentRefundsResponse;
}

// ---------------------------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------------------------

/** A refund as the control plane reports it, with the approver. No idempotency key. */
export interface FinanceRefundResponse extends FinancePaymentRefundResponse {
  approvedBy: string | null;
}

export interface FinanceRefundListResponse {
  items: FinanceRefundResponse[];
  total: number;
  page: number;
  size: number;
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export interface FinanceStatusTotalsResponse {
  currency: string;
  status: string;
  count: number;
  amount: number;
}

export interface FinanceSettlementTotalsResponse {
  currency: string;
  status: string;
  count: number;
  providerPayableGross: number;
  refundClawback: number;
  netPayable: number;
  platformRevenue: number;
  promotionExpense: number;
  customerCashCollected: number;
}

/** Module 08's own summary, field by field — the same shape its `/summary` route returns. */
export interface FinanceCodSummaryResponse {
  count: number;
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount: number;
  outstandingCount: number;
  outstandingAmount: number;
  discrepancyCount: number;
}

/**
 * Four sections, four meanings, no total across them. Amounts are minor units in the row's own
 * currency (`cod` is ETB throughout, as Module 08's summary states). See `FinanceOverviewView`
 * for what each section is and why they are not combined.
 */
export interface FinanceOverviewResponse {
  generatedAt: string;
  payments: { byStatus: FinanceStatusTotalsResponse[] };
  refunds: { byStatus: FinanceStatusTotalsResponse[] };
  settlements: { byStatus: FinanceSettlementTotalsResponse[] };
  cod: FinanceCodSummaryResponse;
}

// ---------------------------------------------------------------------------------------------
// Mappers — explicit allow-lists, never a spread of the port's view
// ---------------------------------------------------------------------------------------------

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toFinancePaymentResponse(p: FinancePaymentView): FinancePaymentResponse {
  return {
    paymentId: p.paymentId,
    orderId: p.orderId,
    customerUserId: p.customerUserId,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    status: p.status,
    provider: p.provider,
    providerRef: p.providerRef,
    originalAmount: p.originalAmount,
    originalCurrency: p.originalCurrency,
    fxRate: p.fxRate,
    fxSource: p.fxSource,
    authorizedAt: iso(p.authorizedAt),
    capturedAt: iso(p.capturedAt),
    failureReason: p.failureReason,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toFinancePaymentListResponse(page: FinancePaymentPage): FinancePaymentListResponse {
  return {
    items: page.items.map(toFinancePaymentResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}

function toPaymentRefundResponse(r: RefundView): FinancePaymentRefundResponse {
  return {
    refundId: r.refundId,
    paymentId: r.paymentId,
    amount: r.amount,
    currency: r.currency,
    type: r.type,
    destination: r.destination,
    status: r.status,
    providerRef: r.providerRef,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    completedAt: iso(r.completedAt),
  };
}

function toPaymentRefundsResponse(v: PaymentRefundsView): FinancePaymentRefundsResponse {
  return {
    capturedAmount: v.capturedAmount,
    totalRefunded: v.totalRefunded,
    remainingRefundable: v.remainingRefundable,
    refunds: v.refunds.map(toPaymentRefundResponse),
  };
}

export function toFinancePaymentDetailResponse(
  view: FinancePaymentDetailView,
): FinancePaymentDetailResponse {
  return {
    payment: toFinancePaymentResponse(view.payment),
    refunds: toPaymentRefundsResponse(view.refunds),
  };
}

export function toFinanceRefundResponse(r: FinanceRefundView): FinanceRefundResponse {
  return {
    refundId: r.refundId,
    paymentId: r.paymentId,
    amount: r.amount,
    currency: r.currency,
    type: r.type,
    destination: r.destination,
    status: r.status,
    providerRef: r.providerRef,
    reason: r.reason,
    approvedBy: r.approvedBy,
    createdAt: r.createdAt.toISOString(),
    completedAt: iso(r.completedAt),
  };
}

export function toFinanceRefundListResponse(page: FinanceRefundPage): FinanceRefundListResponse {
  return {
    items: page.items.map(toFinanceRefundResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}

function toStatusTotals(t: PaymentStatusTotals | RefundStatusTotals): FinanceStatusTotalsResponse {
  return { currency: t.currency, status: t.status, count: t.count, amount: t.amount };
}

function toSettlementTotals(t: SettlementStatusTotals): FinanceSettlementTotalsResponse {
  return {
    currency: t.currency,
    status: t.status,
    count: t.count,
    providerPayableGross: t.providerPayableGross,
    refundClawback: t.refundClawback,
    netPayable: t.netPayable,
    platformRevenue: t.platformRevenue,
    promotionExpense: t.promotionExpense,
    customerCashCollected: t.customerCashCollected,
  };
}

function toCodSummary(s: CodCollectionSummary): FinanceCodSummaryResponse {
  return {
    count: s.count,
    expectedAmount: s.expectedAmount,
    collectedAmount: s.collectedAmount,
    remittedAmount: s.remittedAmount,
    outstandingCount: s.outstandingCount,
    outstandingAmount: s.outstandingAmount,
    discrepancyCount: s.discrepancyCount,
  };
}

export function toFinanceOverviewResponse(view: FinanceOverviewView): FinanceOverviewResponse {
  return {
    generatedAt: view.generatedAt.toISOString(),
    payments: { byStatus: view.payments.map(toStatusTotals) },
    refunds: { byStatus: view.refunds.map(toStatusTotals) },
    settlements: { byStatus: view.settlements.map(toSettlementTotals) },
    cod: toCodSummary(view.cod),
  };
}
