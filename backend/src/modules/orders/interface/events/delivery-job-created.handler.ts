import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { DeliveryEventType, JobCreatedPayload } from '../../../delivery/domain/events';
import { linkDeliveryJobReference } from '../../application/services/delivery-job-reference-linker';
import {
  FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY,
  IFulfillmentDeliveryJobLinkRepository,
} from '../../domain/repositories/fulfillment-delivery-job-link.repository';

/** The maintenance script that recovers any reference this handler could not record. */
export const DELIVERY_JOB_REFERENCE_REPAIR = 'npm run maintenance:backfill-delivery-job-refs';

/**
 * Records Module 08's delivery-job id on the Module 06 fulfillment it was cut for, from Module 08's
 * existing `delivery.job.created` event (`JobCreatedPayload`: `jobId`, `orderId`, `fulfillmentId`,
 * …). The catalogue lists Module 06 as a consumer of `JobCreated`; this is that consumer.
 *
 * Importing the event *contract* is the one cross-module import ADR-002 intends — the mirror of
 * Module 08's `OrderReadyHandler` importing Module 06's `order.ready`. Nothing of Module 08's
 * repositories or tables is touched; the write is Module 06's own, through
 * `IFulfillmentDeliveryJobLinkRepository`, and it changes the reference column only — no status,
 * no timestamp, no amount, no audit entry, no event.
 *
 * ## Delivery guarantees, and what they do not cover
 *
 * The outbox is at-least-once, so a redelivery is expected; the link is a compare-and-set and a
 * second delivery of the same event is `ALREADY_LINKED`. But `EventBusService` isolates a throwing
 * handler and `OutboxRelay` marks the event published either way — **nothing retries this handler**.
 * So a failure here (an exception, or a fulfillment that is missing, mismatched or already linked
 * to another job) is logged as an error naming only ids. A missed reference is then recovered
 * automatically by `DeliveryJobReferenceReconciler` (Work 45), which applies this same rule —
 * `linkDeliveryJobReference` — to Module 08's answer for unreferenced fulfillments; the idempotent
 * maintenance script `DELIVERY_JOB_REFERENCE_REPAIR` remains the operator's one-shot repair.
 */
@Injectable()
export class DeliveryJobCreatedHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(FULFILLMENT_DELIVERY_JOB_LINK_REPOSITORY) private readonly links: IFulfillmentDeliveryJobLinkRepository,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(DeliveryJobCreatedHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<JobCreatedPayload>(DeliveryEventType.JobCreated, (event) => this.handle(event));
  }

  async handle(event: DomainEvent<JobCreatedPayload>): Promise<void> {
    const payload = (event?.payload ?? {}) as Partial<JobCreatedPayload>;
    const { jobId, orderId, fulfillmentId } = payload;
    try {
      const outcome = await linkDeliveryJobReference(this.links, { fulfillmentId, orderId, deliveryJobId: jobId });
      if (outcome === 'INVALID') {
        this.logger.error({
          message: 'Malformed delivery.job.created event; delivery job reference not recorded',
          eventId: event?.id ?? null,
        });
        return;
      }
      if (outcome === 'LINKED' || outcome === 'ALREADY_LINKED') {
        this.logger.log({
          message: outcome === 'LINKED' ? 'Delivery job reference recorded on fulfillment' : 'Delivery job reference already recorded',
          fulfillmentId,
          jobId,
        });
        return;
      }
      this.logger.error({
        message: 'Delivery job reference not recorded on fulfillment',
        outcome,
        fulfillmentId,
        orderId,
        jobId,
        repair: DELIVERY_JOB_REFERENCE_REPAIR,
      });
    } catch (err) {
      this.logger.error({
        message: 'Failed to record delivery job reference on fulfillment',
        fulfillmentId,
        orderId,
        jobId,
        error: err instanceof Error ? err.message : String(err),
        repair: DELIVERY_JOB_REFERENCE_REPAIR,
      });
    }
  }
}
