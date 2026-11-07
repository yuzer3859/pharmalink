import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { CodRemittedPayload, DeliveryEventType } from '../../../delivery/domain/events';
import { CodAccountingService } from '../../application/services/cod-accounting.service';

/**
 * Work 97: Module 07's half of the COD hand-off (module-08 F-COD-01, "reconcile to Payment").
 * `delivery.cod.remitted` says PharmaLink now holds the cash; this posts the COD sale for the
 * amount handed over (`CodAccountingService`). Idempotent by the posting's reference. A failure is
 * logged with the ids; the remittance remains visible in COD reconciliation for finance.
 */
@Injectable()
export class CodRemittedHandler implements OnModuleInit {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly accounting: CodAccountingService,
  ) {
    this.logger.setContext(CodRemittedHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<CodRemittedPayload>(DeliveryEventType.CodRemitted, (event) => this.handle(event));
  }

  async handle(event: DomainEvent<CodRemittedPayload>): Promise<void> {
    const p = (event?.payload ?? {}) as Partial<CodRemittedPayload>;
    if (!p.remittanceId || !p.collectionId || !p.orderId || typeof p.remittedAmount !== 'number' || !p.currency) {
      this.logger.error({ message: 'Malformed delivery.cod.remitted event; nothing posted', eventId: event?.id ?? null });
      return;
    }
    try {
      const outcome = await this.accounting.postRemittance({
        remittanceId: p.remittanceId,
        collectionId: p.collectionId,
        orderId: p.orderId,
        remittedAmount: p.remittedAmount,
        currency: p.currency,
      });
      this.logger.log({ message: 'COD remittance applied to the ledger', remittanceId: p.remittanceId, orderId: p.orderId, outcome });
    } catch (err) {
      this.logger.error({
        message: 'Could not post a COD remittance to the ledger',
        remittanceId: p.remittanceId,
        orderId: p.orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
