import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { EVENT_BUS, IEventBus } from '../../../../shared/events/event-bus.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  DispatchDeliveryJobCommand,
  DispatchOutcome,
} from '../../application/commands/dispatch-delivery-job.command';
import { DeliveryEventType, JobCreatedPayload } from '../../domain/events';

/**
 * Dispatches a job as soon as it is created (§11.1's "CreateDeliveryJob → DispatchJob").
 *
 * ## Why an event rather than a call inside `CreateDeliveryJobCommand`
 *
 * The design writes the two steps as one flow, and they could have been one transaction. They are
 * not, for the same reason the job-creation work kept its cross-module reads outside its
 * transaction: dispatch reads Module 01 to check verification (ADR-014), and a `Serializable`
 * transaction that spanned the creation *and* the candidate search would hold a write lock on
 * `delivery_jobs` across a cross-context read.
 *
 * Splitting them at the outbox also makes the failure mode the right one. A job that is created
 * but not yet offered is a `CREATED` row that any later dispatch pass can pick up; a job whose
 * creation rolled back because no driver happened to be online at that instant would be an order
 * with no delivery record at all.
 *
 * ## This handler is the *only* automatic dispatch trigger today
 *
 * Declines re-dispatch themselves, reassignment re-dispatches itself, and an expired offer is
 * retired by whichever dispatch pass next looks at the job. What does **not** yet exist is a
 * periodic sweeper for a job that reached `NoCandidate` and has been sitting since — see the
 * module's deferred list. That is why `NoCandidate` writes an audit entry: until the sweeper
 * exists, that entry is how an operator finds the job.
 *
 * Failures are logged and swallowed, exactly as `OrderReadyHandler` does and for the same reason:
 * `EventBusService` isolates a throwing handler rather than retrying it, so rethrowing would lose
 * the context and buy nothing. An undispatched job is a visible operational condition.
 */
@Injectable()
export class JobCreatedHandler implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly dispatch: DispatchDeliveryJobCommand,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(JobCreatedHandler.name);
  }

  onModuleInit(): void {
    this.bus.subscribe<JobCreatedPayload>(DeliveryEventType.JobCreated, (event) =>
      this.handle(event),
    );
  }

  private async handle(event: DomainEvent<JobCreatedPayload>): Promise<void> {
    const { jobId, orderId } = event.payload;
    try {
      const result = await this.dispatch.execute({
        // A dispatch driven by an event has no human actor — the same `null`
        // `CreateDeliveryJobCommand` records for its own event-driven path.
        jobId,
        actorUserId: null,
      });

      if (result.outcome === DispatchOutcome.NoCandidate) {
        // Warn rather than error: nobody online at 3am is an operating condition, not a fault.
        // The job stays dispatchable and the audit entry is the durable record.
        this.logger.warn({
          message: 'No eligible driver for delivery job',
          jobId,
          orderId,
          status: result.job.status,
        });
        return;
      }

      this.logger.log({
        message:
          result.outcome === DispatchOutcome.AlreadyOffered
            ? 'Delivery job already offered'
            : 'Delivery job offered',
        jobId,
        orderId,
        offerId: result.offer?.id ?? null,
        driverId: result.offer?.driverId ?? null,
        round: result.offer?.round ?? null,
      });
    } catch (err) {
      this.logger.error({
        message: 'Failed to dispatch delivery job',
        jobId,
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
