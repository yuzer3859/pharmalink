import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { LedgerAccountType, LedgerDirection, LedgerTransactionType } from '../../domain/enums';
import { ILedgerRepository, LEDGER_REPOSITORY } from '../../domain/repositories/ledger.repository';
import { FeeCalculator } from '../../domain/services/fee-calculator';
import { LedgerService } from '../../domain/services/ledger.service';
import { AccountRef } from '../../domain/value-objects/account-ref.vo';
import { Money } from '../../domain/value-objects/money.vo';
import { IOrderPort, ORDER_PORT } from '../ports/outbound/order.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithPaymentRetry } from '../support/payment-retry';
import { CaptureAccountingService } from './capture-accounting.service';

/** The COD sale posting's deterministic reference: one per remittance, so a redelivered event posts once. */
export function codSaleLedgerReference(remittanceId: string): string {
  return `COD-${remittanceId}`;
}

export interface CodRemittance {
  remittanceId: string;
  collectionId: string;
  orderId: string;
  remittedAmount: number;
  currency: string;
}

export type CodPostingOutcome = 'POSTED' | 'ALREADY_POSTED' | 'NEEDS_FINANCE';

/**
 * Work 97: cash-on-delivery money in the ledger (Phase 1 audit gap G4).
 *
 * **Owner's decision (2026-11-07): a pharmacy is owed COD money only once the cash reaches
 * PharmaLink.** So the sale is posted when the delivery channel hands the cash over
 * (`delivery.cod.remitted`), never when the driver collects it, and only for the amount handed
 * over:
 *
 * ```
 * DEBIT  COD_CLEARING        remitted                 cash PharmaLink holds from the COD channel
 * DEBIT  PROMOTION_EXPENSE   order.discountTotal      a platform-funded coupon (ADR-019), if any
 * CREDIT PROVIDER_PAYABLE    remitted − fee + discount  what the pharmacy is owed
 * CREDIT PLATFORM_REVENUE    order.platformFee        PharmaLink's commission (BRULE-23)
 * ```
 *
 * The same split as a gateway capture (`FeeCalculator.splitCapture`), with COD clearing in place
 * of gateway clearing. Settlement then pays it like any other posting to the pharmacy's payable.
 * A shortfall (less handed over than collected) is therefore never paid to the pharmacy; it stays
 * with the COD reconciliation and dispute process. A remittance smaller than the commission cannot
 * be split and is left to finance (logged, nothing posted).
 */
@Injectable()
export class CodAccountingService {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(ORDER_PORT) private readonly orders: IOrderPort,
    @Inject(LEDGER_REPOSITORY) private readonly ledgerRows: ILedgerRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly ledger: LedgerService,
    private readonly capture: CaptureAccountingService,
  ) {
    this.logger.setContext(CodAccountingService.name);
  }

  async postRemittance(remittance: CodRemittance): Promise<CodPostingOutcome> {
    const reference = codSaleLedgerReference(remittance.remittanceId);
    if (await this.ledgerRows.findTransactionByReference(reference)) return 'ALREADY_POSTED';

    const order = await this.orders.getOrder(remittance.orderId);
    if (!order) {
      this.logger.error({ message: 'COD remittance for an unknown order; nothing posted', ...remittance });
      return 'NEEDS_FINANCE';
    }
    if (!(remittance.remittedAmount > 0) || remittance.remittedAmount < order.platformFee) {
      this.logger.error({
        message: 'COD remittance is smaller than the platform commission; nothing posted, finance must resolve it',
        ...remittance,
        platformFee: order.platformFee,
      });
      return 'NEEDS_FINANCE';
    }

    const pharmacyId = await this.capture.resolveProviderPharmacyId(order.id);
    // More handed over than the order total (a counting error) is not the pharmacy's either: the
    // sale is at most what the customer owed; the excess stays with COD reconciliation.
    const gross = Math.min(remittance.remittedAmount, order.grandTotal);
    const split = FeeCalculator.splitCapture({
      gross: Money.of(gross, remittance.currency),
      platformFee: Money.of(order.platformFee, order.currency),
      discountTotal: Money.of(order.discountTotal, order.currency),
    });

    return runWithPaymentRetry(this.uow, async (tx) => {
      if (await this.ledgerRows.findTransactionByReference(reference, tx)) return 'ALREADY_POSTED';
      const [clearing, payable, revenue, promotion] = await Promise.all([
        this.ledger.resolveAccount(AccountRef.platform(LedgerAccountType.COD_CLEARING, remittance.currency), tx),
        this.ledger.resolveAccount(AccountRef.providerPayable(pharmacyId, remittance.currency), tx),
        this.ledger.resolveAccount(AccountRef.platform(LedgerAccountType.PLATFORM_REVENUE, remittance.currency), tx),
        split.promotionExpense.isPositive
          ? this.ledger.resolveAccount(AccountRef.platform(LedgerAccountType.PROMOTION_EXPENSE, remittance.currency), tx)
          : Promise.resolve(null),
      ]);
      await this.ledger.post(
        {
          reference,
          type: LedgerTransactionType.COD_SALE,
          refType: 'cod_remittance',
          refId: remittance.remittanceId,
          description: `COD sale for order ${order.id}, cash handed over (collection ${remittance.collectionId})`,
          entries: [
            { accountId: clearing.id, direction: LedgerDirection.DEBIT, amount: split.gross },
            ...(promotion && split.promotionExpense.isPositive
              ? [{ accountId: promotion.id, direction: LedgerDirection.DEBIT, amount: split.promotionExpense }]
              : []),
            ...(split.providerNet.isPositive
              ? [{ accountId: payable.id, direction: LedgerDirection.CREDIT, amount: split.providerNet }]
              : []),
            ...(split.fee.isPositive ? [{ accountId: revenue.id, direction: LedgerDirection.CREDIT, amount: split.fee }] : []),
          ],
        },
        tx,
      );
      return 'POSTED' as const;
    });
  }
}
