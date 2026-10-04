import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetFinanceOverviewQuery } from '../../application/queries/get-finance-overview.query';
import { GetFinancePaymentQuery } from '../../application/queries/get-finance-payment.query';
import { ListFinancePaymentsQuery } from '../../application/queries/list-finance-payments.query';
import { ListFinanceRefundsQuery } from '../../application/queries/list-finance-refunds.query';
import { ListFinancePaymentsQueryDto, ListFinanceRefundsQueryDto } from '../dtos/finance.dto';
import {
  FinanceOverviewResponse,
  FinancePaymentDetailResponse,
  FinancePaymentListResponse,
  FinanceRefundListResponse,
  toFinanceOverviewResponse,
  toFinancePaymentDetailResponse,
  toFinancePaymentListResponse,
  toFinanceRefundListResponse,
} from '../dtos/finance.response';

/**
 * Finance & settlement oversight (module-16 §9.6, F-AD-19) — the control plane's **read-only**
 * view of the money the marketplace has already moved or recorded.
 *
 *     GET /admin/finance/overview       payments, refunds, settlements and COD cash, by status
 *     GET /admin/finance/payments       every payment, across customers, newest first
 *     GET /admin/finance/payments/{id}  one payment with its refunds and remaining refundable
 *     GET /admin/finance/refunds        every refund, across payments, newest first
 *
 * ## Read-only, structurally
 *
 * Four `@Get`s and nothing else. The queries behind them hold no command, and the ports they
 * read through (`IFinanceOversightPort`, `ICodFinanceReadPort`) expose none: there is no path
 * from this controller to a capture, a refund, a void, a settlement run, a remittance or a
 * ledger posting, and adding a mutation here would first require adding one to a port whose
 * doc comment says it has none. Every one of those actions keeps its own route, its own
 * permission and its own audit entry in Module 07 or Module 08.
 *
 * ## What Modules 07 and 08 already serve, and is not duplicated here
 *
 * Module 07 owns `/admin/finance/settlements` (`GET`, `GET /{id}`, `POST /run`, all
 * `finance:settlement:any`), `/admin/finance/reconciliation` and `/admin/finance/coupons`.
 * Module 08 owns `/admin/delivery/cod-reconciliation` (queue, `/summary`, `/{collectionId}`, and
 * the remit/reconcile/correction/dispute actions). None of those is re-served under another
 * path: a statement is read where Module 07 serves it, a collection where Module 08 does. This
 * controller shares Module 07's `/admin/finance` namespace only with literal segments that no
 * existing route claims — there is no `/admin/finance/{param}` anywhere, so nothing can shadow
 * or be shadowed.
 *
 * What *was* missing, and is here: a payment read that spans customers (§9.1's is the payer's
 * own), a refund read that spans payments (§9.3's is one payment's), and the stored figures
 * summed by status — including the COD summary beside them, which is the one place the four
 * kinds of money can be seen together without being added together.
 *
 * ## Authorization
 *
 * `finance:report:any` on the class — the catalog's finance *reporting* key, held by
 * `FINANCE_OFFICER`, `ADMIN` and `SUPER_ADMIN`, and exactly what Module 07's reconciliation
 * report and Module 08's COD queue already require for the same kind of read. Not
 * `finance:settlement:any`: that is the mutation key (and the key for Module 07's per-statement
 * reads, where it sits on a class that also runs statements), and this surface mutates nothing.
 * One consequence, stated so it is a decision and not an accident: an `ADMIN` sees settlement
 * *totals by status* here and still cannot open a statement on Module 07's route. No grant was
 * changed.
 *
 * ## Audit
 *
 * Nothing is written. The repository still has no sensitive-read audit convention (re-checked in
 * this work: no `*_VIEWED` action anywhere), and Work 05's reasoning for not inventing one holds.
 *
 * Errors are not caught — the global filter maps them: `NOT_FOUND` (404) for an unknown payment,
 * `VALIDATION_ERROR` (400) for a malformed id or filter, `FORBIDDEN` (403) for an unentitled
 * caller.
 */
@Controller('admin/finance')
@RequirePermissions('finance:report:any')
export class AdminFinanceController {
  constructor(
    private readonly overview: GetFinanceOverviewQuery,
    private readonly listPayments: ListFinancePaymentsQuery,
    private readonly getPayment: GetFinancePaymentQuery,
    private readonly listRefunds: ListFinanceRefundsQuery,
  ) {}

  @Get('overview')
  async getOverview(): Promise<FinanceOverviewResponse> {
    return toFinanceOverviewResponse(await this.overview.execute());
  }

  @Get('payments')
  async searchPayments(
    @Query() query: ListFinancePaymentsQueryDto,
  ): Promise<FinancePaymentListResponse> {
    return toFinancePaymentListResponse(
      await this.listPayments.execute({
        status: query.status,
        method: query.method,
        provider: query.provider,
        orderId: query.orderId,
        customerUserId: query.customerUserId,
        createdFrom: toDate(query.createdFrom),
        createdTo: toDate(query.createdTo),
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get('payments/:id')
  async getPaymentDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FinancePaymentDetailResponse> {
    return toFinancePaymentDetailResponse(await this.getPayment.execute(id));
  }

  @Get('refunds')
  async searchRefunds(
    @Query() query: ListFinanceRefundsQueryDto,
  ): Promise<FinanceRefundListResponse> {
    return toFinanceRefundListResponse(
      await this.listRefunds.execute({
        status: query.status,
        type: query.type,
        destination: query.destination,
        paymentId: query.paymentId,
        createdFrom: toDate(query.createdFrom),
        createdTo: toDate(query.createdTo),
        page: query.page,
        size: query.size,
      }),
    );
  }
}

/** `@IsDateString` has already rejected anything unparseable, so this cannot yield `Invalid Date`. */
function toDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
