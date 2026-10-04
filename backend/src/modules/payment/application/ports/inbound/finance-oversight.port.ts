import { Inject, Injectable } from '@nestjs/common';
import { PaymentProps } from '../../../domain/entities/payment.entity';
import { RefundProps } from '../../../domain/entities/refund.entity';
import {
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
} from '../../../domain/enums';
import {
  IPaymentRepository,
  PAYMENT_REPOSITORY,
  PaymentSearchCriteria,
  PaymentStatusTotals,
} from '../../../domain/repositories/payment.repository';
import {
  IRefundRepository,
  REFUND_REPOSITORY,
  RefundSearchCriteria,
  RefundStatusTotals,
} from '../../../domain/repositories/refund.repository';
import {
  ISettlementRepository,
  SETTLEMENT_REPOSITORY,
  SettlementStatusTotals,
} from '../../../domain/repositories/settlement.repository';
import {
  ListPaymentRefundsQuery,
  PaymentRefundsView,
} from '../../queries/list-payment-refunds.query';

export const FINANCE_OVERSIGHT_PORT = Symbol('FINANCE_OVERSIGHT_PORT');

/**
 * Re-exported so a consumer depends on this one file and not on Module 07's domain layer. The
 * enums are Module 07's; a consumer may name their values, never add to them.
 */
export {
  PaymentMethod,
  PaymentStatus,
  RefundDestination,
  RefundStatus,
  RefundType,
  SettlementStatus,
} from '../../../domain/enums';
export type { PaymentSearchCriteria, PaymentStatusTotals } from '../../../domain/repositories/payment.repository';
export type { RefundSearchCriteria, RefundStatusTotals } from '../../../domain/repositories/refund.repository';
export type { SettlementStatusTotals } from '../../../domain/repositories/settlement.repository';
export type { PaymentRefundsView, RefundView } from '../../queries/list-payment-refunds.query';

/**
 * A payment as platform finance sees it — `PaymentView` (§9.1's customer projection) plus the
 * fields a customer has no use for but an oversight desk does: who paid, the cross-border
 * originals (§8), and when the row last moved.
 *
 * What is **deliberately absent** is the same as `PaymentView`, and for the same reasons:
 * `providerToken` (the gateway's stand-in for the instrument — a credential, BRULE-26) and
 * `idempotencyKey` (the caller's; echoing it lets one leak into a shared log). `providerRef` is
 * the gateway's transaction reference, quoted on statements, and not a credential.
 */
export interface FinancePaymentView {
  paymentId: string;
  orderId: string;
  customerUserId: string;
  amount: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: string | null;
  providerRef: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
  fxSource: string | null;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FinancePaymentPage {
  items: FinancePaymentView[];
  total: number;
  page: number;
  size: number;
}

/** One payment with §9.3's refund view beside it — the same projection `GET /payments/{id}/refunds` returns. */
export interface FinancePaymentDetailView {
  payment: FinancePaymentView;
  refunds: PaymentRefundsView;
}

/**
 * A refund as platform finance sees it — `RefundView` (§9.3's customer projection) plus
 * `approvedBy`, the finance officer who authorised a manual refund. `RefundView` keeps that out
 * of a *customer-readable* projection; this one is read under platform finance authority, where
 * the approver is exactly what an oversight desk asks. `idempotencyKey` stays absent.
 */
export interface FinanceRefundView {
  refundId: string;
  paymentId: string;
  amount: number;
  /** The payment's currency — §7's `refunds` has no currency column (see `RefundProps`). */
  currency: string;
  type: RefundType;
  destination: RefundDestination;
  status: RefundStatus;
  providerRef: string | null;
  reason: string | null;
  approvedBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface FinanceRefundPage {
  items: FinanceRefundView[];
  total: number;
  page: number;
  size: number;
}

/**
 * The three kinds of money this module keeps, each summed by status and each kept apart.
 *
 * - `payments` — what customers paid through a gateway, bucketed by the payment's status.
 * - `refunds` — what has gone (or is going) back to customers, bucketed by the refund's status.
 * - `settlements` — what statements say pharmacies are owed, bucketed by the statement's status.
 *
 * There is deliberately no figure that combines them. A captured payment is not a payable, a
 * payable is not cash on hand, and a sum across the three would be a number with no definition
 * in this module's accounting (§11). Refunds are not netted from payments here either: a payment
 * that was partly refunded still sits in its own status bucket at its full captured amount, and
 * the refund sits in its own — the reader is shown both and subtracts nothing on their behalf.
 */
export interface FinanceTotalsView {
  payments: PaymentStatusTotals[];
  refunds: RefundStatusTotals[];
  settlements: SettlementStatusTotals[];
}

/**
 * Module 07's exported contract for **read-only finance oversight**, consumed in-process by
 * Module 16 (module-16 Work 07) through Nest DI — the same inbound-port shape as
 * `IPaymentAuthorizationPort` and `IWalletPort` (ADR-002).
 *
 * Every operation is a read, and the port has no way to become anything else: it holds no
 * command, and the adapter injects nothing that writes. Refunds, captures, voids, settlement
 * runs and coupon curation keep their own routes and permissions in this module.
 *
 * The projections are decided *here*, not by the consumer: what crosses this seam is already the
 * safe shape, so a control plane cannot widen it by reaching for a field the repository snapshot
 * happens to carry.
 */
export interface IFinanceOversightPort {
  /** Platform-wide payments, newest first. */
  listPayments(criteria: PaymentSearchCriteria, page: number, size: number): Promise<FinancePaymentPage>;

  /** One payment with its refunds and remaining refundable, or `null` when there is no such payment. */
  getPayment(paymentId: string): Promise<FinancePaymentDetailView | null>;

  /** Platform-wide refunds, newest first. */
  listRefunds(criteria: RefundSearchCriteria, page: number, size: number): Promise<FinanceRefundPage>;

  /** The stored figures summed by status. Computes nothing that is not a sum of a column. */
  totals(): Promise<FinanceTotalsView>;
}

/**
 * Implements `IFinanceOversightPort` over the repositories and §9.3's refund query — a facade
 * with two responsibilities: forward, and project. It re-derives no figure and decides no
 * eligibility; the totals are the repositories' `GROUP BY`s and the refund figures are
 * `ListPaymentRefundsQuery`'s, called without a customer scope exactly as its doc comment
 * describes for a finance route.
 */
@Injectable()
export class FinanceOversightPortAdapter implements IFinanceOversightPort {
  constructor(
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepository,
    @Inject(REFUND_REPOSITORY) private readonly refunds: IRefundRepository,
    @Inject(SETTLEMENT_REPOSITORY) private readonly settlements: ISettlementRepository,
    private readonly listPaymentRefunds: ListPaymentRefundsQuery,
  ) {}

  async listPayments(
    criteria: PaymentSearchCriteria,
    page: number,
    size: number,
  ): Promise<FinancePaymentPage> {
    const result = await this.payments.search(criteria, page, size);
    return {
      items: result.items.map(toFinancePaymentView),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  }

  async getPayment(paymentId: string): Promise<FinancePaymentDetailView | null> {
    const payment = await this.payments.findById(paymentId);
    if (!payment) {
      return null;
    }
    // No `customerUserId`: the caller holds platform authority, which is the unscoped case that
    // query documents. It throws only for a missing payment, which was just ruled out.
    const refunds = await this.listPaymentRefunds.execute({ paymentId: payment.id });
    return { payment: toFinancePaymentView(payment), refunds };
  }

  async listRefunds(
    criteria: RefundSearchCriteria,
    page: number,
    size: number,
  ): Promise<FinanceRefundPage> {
    const result = await this.refunds.search(criteria, page, size);
    return {
      items: result.items.map((row) => toFinanceRefundView(row.refund, row.currency)),
      total: result.total,
      page: result.page,
      size: result.size,
    };
  }

  async totals(): Promise<FinanceTotalsView> {
    const [payments, refunds, settlements] = await Promise.all([
      this.payments.summarizeByStatus(),
      this.refunds.summarizeByStatus(),
      this.settlements.summarizeByStatus(),
    ]);
    return { payments, refunds, settlements };
  }
}

/** Field by field, so a column added to `PaymentProps` later is not exported by accident. */
function toFinancePaymentView(p: PaymentProps): FinancePaymentView {
  return {
    paymentId: p.id,
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
    authorizedAt: p.authorizedAt,
    capturedAt: p.capturedAt,
    failureReason: p.failureReason,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    // `providerToken` and `idempotencyKey` are deliberately not here — see the interface doc.
  };
}

function toFinanceRefundView(r: RefundProps, currency: string): FinanceRefundView {
  return {
    refundId: r.id,
    paymentId: r.paymentId,
    amount: r.amount,
    currency,
    type: r.type,
    destination: r.destination,
    status: r.status,
    providerRef: r.providerRef,
    reason: r.reason,
    approvedBy: r.approvedBy,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    // `idempotencyKey` is deliberately not here — see the interface doc.
  };
}
