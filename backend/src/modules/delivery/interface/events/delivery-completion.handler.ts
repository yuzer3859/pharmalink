import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { AccrueDriverEarningCommand } from '../../application/commands/accrue-driver-earning.command';
import { AdvanceDeliveryJobCommand } from '../../application/commands/advance-delivery-job.command';
import { DeliveryJobStatus } from '../../domain/enums';
import { DeliveryEventType, DeliveryStatusPayload } from '../../domain/events';

/**
 * Closes a delivery once it has physically happened: accrue the driver's earning, then complete the
 * job (§6's `CompleteDelivery → AccrueEarning (idempotent) → DriverEarning(ACCRUED)`, §10's "on
 * OrderDelivered → notify + earning + order sync", F-ERN-01, BR-DEL-10).
 *
 * ## This is what finally makes `COMPLETED` reachable
 *
 * The status work built the `DELIVERED → COMPLETED` transition and deliberately left nothing
 * driving it, because `COMPLETED` means "the platform has squared its books" and there were no
 * books to square. There are now. This handler is the first — and today the only — automatic
 * trigger for that transition.
 *
 * ## Why an event rather than a call inside the `DELIVERED` transition
 *
 * The two could have been one transaction, and making them one would be wrong in a way that shows
 * up at the worst moment. `DELIVERED` is a driver standing at somebody's door posting that the
 * handover happened; if accrual were part of that request, a bookkeeping failure — a missing
 * distance, a serialization conflict, a configuration an operator had half-finished — would
 * **reject the driver's post**. The medicines would be with the customer and the platform would be
 * insisting they were not.
 *
 * Splitting at the outbox puts the failure in the right place. The physical fact commits on its
 * own; the money follows. A delivery whose accrual failed is a `DELIVERED` row that any later
 * re-run picks up, which is §7's recoverable path stated as a structure rather than a promise.
 *
 * ## Order, and why completion goes second
 *
 * Accrual first, completion second, and never the reverse. `AdvanceDeliveryJobCommand` refuses a
 * `COMPLETED` transition whose earning is missing, so the ordering is enforced there rather than
 * merely observed here — but doing it in this order also means the ordinary path never hits that
 * refusal. If accrual throws, completion is not attempted at all and the job stays `DELIVERED`.
 *
 * Both steps are idempotent, which is what makes a redelivered event harmless: the earning is
 * unique on `jobId` and returns the committed row, and the transition returns `changed: false` when
 * the job is already `COMPLETED`. Re-running this handler writes nothing the second time.
 *
 * ## Failures are logged and swallowed
 *
 * Exactly as `JobCreatedHandler` and `OrderReadyHandler` do, and for the same reason:
 * `EventBusService` isolates a throwing handler rather than retrying it, so rethrowing would lose
 * the context and buy nothing.
 *
 * The consequence is deliberate and is the right one. A delivery stuck at `DELIVERED` is a visible
 * operational condition with a customer who has their medicine, a driver whose work is recorded in
 * `delivery_status_history`, and an accrual an operator can re-run. The alternative — completing
 * the job anyway — would close the books on a driver who is owed nothing on record, and
 * `COMPLETED` is terminal.
 */
@Injectable()
export class DeliveryCompletionHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly accrue: AccrueDriverEarningCommand,
    private readonly advance: AdvanceDeliveryJobCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(DeliveryCompletionHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<DeliveryStatusPayload>(DeliveryEventType.OrderDelivered, (event) =>
      this.handle(event),
    );
  }

  private async handle(event: DomainEvent<DeliveryStatusPayload>): Promise<void> {
    const { jobId, orderId } = event.payload;

    let earningId: string;
    try {
      // No actor: a completion driven by an event has no human behind it, the same `null`
      // `CreateDeliveryJobCommand` records on its own event-driven path.
      const result = await this.accrue.execute({ jobId, actorUserId: null });
      earningId = result.earning.id;
    } catch (err) {
      // The job stays `DELIVERED`. Nothing about the physical delivery is retracted, and the
      // accrual is re-runnable — see the class comment on why this is the correct failure.
      this.logger.error({
        message: 'Driver earning accrual failed; delivery job left DELIVERED',
        jobId,
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      const { changed } = await this.advance.bySystem({
        jobId,
        to: DeliveryJobStatus.COMPLETED,
      });
      this.logger.log({
        message: changed
          ? 'Delivery job completed'
          : 'Delivery job already completed',
        jobId,
        orderId,
        earningId,
      });
    } catch (err) {
      // The earning is committed and the delivery is recorded; only the closing transition is
      // outstanding, and it is idempotent, so a re-run costs nothing.
      this.logger.error({
        message: 'Delivery job completion failed after earning accrual',
        jobId,
        orderId,
        earningId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
