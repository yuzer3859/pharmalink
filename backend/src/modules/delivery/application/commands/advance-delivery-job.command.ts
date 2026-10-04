import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { OutboxService, OutboxCapableClient } from '../../../../shared/outbox/outbox.service';
import { DeliveryJob, DeliveryJobProps } from '../../domain/entities/delivery-job.entity';
import { DeliveryActorType, DeliveryJobStatus } from '../../domain/enums';
import {
  DeliveryStatusPayload,
  deliveryFailedEvent,
  enRouteEvent,
  orderDeliveredEvent,
  orderPickedUpEvent,
} from '../../domain/events';
import { DeliveryErrors } from '../../domain/errors';
import {
  DELIVERY_JOB_REPOSITORY,
  IDeliveryJobRepository,
} from '../../domain/repositories/delivery-job.repository';
import {
  DRIVER_PROFILE_REPOSITORY,
  IDriverProfileRepository,
} from '../../domain/repositories/driver-profile.repository';
import {
  COD_COLLECTION_REPOSITORY,
  ICodCollectionRepository,
} from '../../domain/repositories/cod-collection.repository';
import {
  DRIVER_EARNING_REPOSITORY,
  IDriverEarningRepository,
} from '../../domain/repositories/driver-earning.repository';
import {
  IProofOfDeliveryRepository,
  PROOF_OF_DELIVERY_REPOSITORY,
} from '../../domain/repositories/proof-of-delivery.repository';
import {
  PodRequirement,
  ProofOfDeliveryPolicy,
} from '../../domain/services/proof-of-delivery-policy';
import { resolveCodSettings } from '../services/cod-settings';
import { resolvePodSettings } from '../services/pod-requirement';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithDeliveryRetry } from '../support/delivery-retry';

/** What a driver may drive their own job to (§9.2's explicit endpoints). */
export const DRIVER_SETTABLE_STATUSES: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.ARRIVED_PICKUP,
  DeliveryJobStatus.PICKED_UP,
  DeliveryJobStatus.EN_ROUTE,
  DeliveryJobStatus.ARRIVED_DROPOFF,
  DeliveryJobStatus.DELIVERED,
  DeliveryJobStatus.FAILED,
];

/** The statuses whose transition requires a stated reason. */
const REQUIRES_REASON: readonly DeliveryJobStatus[] = [
  DeliveryJobStatus.FAILED,
  DeliveryJobStatus.CANCELLED,
];

export interface DriverAdvanceInput {
  /** Module 01 `users.id`, from the access token. **Never** a client-supplied driver id. */
  userId: string;
  jobId: string;
  to: DeliveryJobStatus;
  /** Required for `FAILED` (§3.3 F-STS-05's recipient-absent case). */
  reason?: string | null;
  /** Where the driver was when they posted it (§13's "with geo"). */
  lat?: number | null;
  lng?: number | null;
}

export interface SystemAdvanceInput {
  jobId: string;
  to: DeliveryJobStatus;
  reason?: string | null;
  actorUserId?: string | null;
  actorType?: DeliveryActorType;
}

export interface AdvanceDeliveryJobResult {
  job: DeliveryJobProps;
  /** `false` when the job was already in the requested status and nothing was written. */
  changed: boolean;
}

/**
 * `AdvanceDeliveryJob` (§3.3 F-STS-01/F-STS-03, §11.4, BR-DEL-07) — moves a job along its
 * lifecycle.
 *
 * ```
 * ASSIGNED → ARRIVED_PICKUP → PICKED_UP → EN_ROUTE → ARRIVED_DROPOFF → DELIVERED → COMPLETED
 *                                    └──────────────────┴──────────────┴──► FAILED
 * ```
 *
 * ## One command, six routes
 *
 * Every transition shares the same five concerns — ownership, idempotency, legality,
 * compare-and-set, and the trail — and differs only in the target status and which event it
 * emits. Six commands would be six copies of that logic, and the copy that drifted would be the
 * one nobody noticed. `DeliveryStatusPolicy` is already the single authority on legality, so this
 * command parameterises the target and asks the policy; the controller keeps the six explicit
 * endpoints §9.2 names, because *those* are the business operations.
 *
 * ## Ownership
 *
 * The driver is resolved from the authenticated `users.id` to their `driver_profiles.id`, and the
 * job must currently name that profile. A client-supplied driver id is never accepted anywhere on
 * this path — it would be an authorization decision handed to the caller.
 *
 * The check is made twice: once on the read, and once **inside the transaction** against the row
 * the compare-and-set is about to move. That second check is the one that matters, because a
 * reassignment can commit in between, and a driver who was released must not be able to advance a
 * job that now belongs to somebody else.
 *
 * A job that belongs to another driver answers `NOT_FOUND`, not `FORBIDDEN`: job ids must not be
 * probeable for who is carrying what (`00-shared-conventions.md` §1).
 *
 * ## Idempotency, without self-loops
 *
 * §12 requires status posts to be idempotent ("duplicate `/picked-up` returns current state, not
 * error — NFR-LOC-04"), because a driver's handset retries on every timeout and reconnect. The
 * state machine still has **no self-loops** — `DeliveryStatusPolicy` would refuse
 * `PICKED_UP → PICKED_UP`, and adding the loop would make every transition re-runnable and every
 * timestamp re-writable.
 *
 * So the retry is resolved *here*, at the application boundary, exactly where the design puts it:
 * if the job already holds the requested status, the current state is returned with
 * `changed: false` and **nothing is written** — no history row, no audit entry, no outbox event.
 * That last part is what makes the guarantee real rather than cosmetic: a duplicate `/picked-up`
 * that re-emitted `OrderPickedUp` would advance Module 06's order twice.
 *
 * A request that is neither a repeat nor a legal move — `PICKED_UP` arriving when the job is
 * already `EN_ROUTE` — is refused with `INVALID_DELIVERY_STATE_TRANSITION`. A stale request can
 * therefore never move the job backwards, and the driver's app learns that its view is behind.
 *
 * ## Concurrency
 *
 * `updateState` is a compare-and-set, inside a `Serializable` transaction (ADR-013), and it
 * compares **both** the status the transition was computed from and — for a driver's post — the
 * driver who was just checked for ownership. Two requests racing the same transition both read
 * `ARRIVED_PICKUP`; one matches the row and moves it, the other matches nothing. The loser then
 * re-reads: if the job now holds the status it wanted, it was a duplicate and returns success;
 * otherwise it is a genuine conflict and is refused. Last-write-wins is impossible by
 * construction.
 *
 * Putting the driver in the `WHERE` clause is what makes "still assigned to this driver" a
 * database guarantee rather than a consequence of the isolation level detecting a read-write
 * dependency. Serializable would very likely catch a reassignment landing between the ownership
 * check and the write — but an authorization rule should not rest on "very likely".
 *
 * ## What it does not do
 *
 * It does not advance the order — §1 gives order state to Module 06, which consumes the events
 * written here. It does not capture proof of delivery, accrue an earning, reconcile COD cash or
 * publish a location: each is its own command, reached by its own path.
 *
 * What it does do is **refuse** a transition whose preconditions are unmet, and there are now
 * three of them, all checked inside the transaction and immediately before the write. `DELIVERED`
 * requires the proof BRULE-29's policy demands. `COMPLETED` requires the driver earning BR-DEL-10
 * demands, and — where an operator has switched the rule on — a recorded COD collection. None of
 * them writes anything, so a refused transition leaves the job exactly where it was.
 *
 * Note which transition carries which. Every money and paperwork condition sits on `COMPLETED`;
 * `DELIVERED` carries only the evidence rule, and nothing about cash. That is what lets `DELIVERED`
 * remain a statement about the physical world that no bookkeeping failure can retract.
 */
@Injectable()
export class AdvanceDeliveryJobCommand {
  constructor(
    @Inject(DELIVERY_JOB_REPOSITORY) private readonly jobs: IDeliveryJobRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    @Inject(PROOF_OF_DELIVERY_REPOSITORY) private readonly proofs: IProofOfDeliveryRepository,
    @Inject(DRIVER_EARNING_REPOSITORY) private readonly earnings: IDriverEarningRepository,
    @Inject(COD_COLLECTION_REPOSITORY) private readonly codCollections: ICodCollectionRepository,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** A driver posting progress on the job they are carrying (§9.2). */
  async byDriver(input: DriverAdvanceInput): Promise<AdvanceDeliveryJobResult> {
    const userId = requireText(input.userId, 'userId');
    const jobId = requireText(input.jobId, 'jobId');

    if (!DRIVER_SETTABLE_STATUSES.includes(input.to)) {
      // `COMPLETED`, `CANCELLED` and `REASSIGNING` are the platform's, not the driver's — see
      // `bySystem`. Refused by target rather than by transition so the answer does not depend on
      // where the job happens to be.
      throw DeliveryErrors.validation(`A driver cannot set a job to ${input.to}.`, {
        field: 'status',
        status: input.to,
      });
    }

    const profile = await this.profiles.findByUserId(userId);
    if (!profile) {
      throw DeliveryErrors.driverProfileNotFound({ userId });
    }

    // BRULE-09, read live. A driver whose approval was revoked mid-delivery must not be able to
    // take *new* action on the platform — but see `FAILED` below: they are not trapped either.
    // Outside the transaction per ADR-014; nothing the transaction does can change the answer.
    const identity = await this.identity.getDriverIdentity(userId);
    if (!identity.isEligible) {
      throw DeliveryErrors.driverNotVerified(userId, identity.reason ?? 'UNKNOWN');
    }

    return this.apply({
      jobId,
      to: input.to,
      reason: input.reason ?? null,
      expectedDriverId: profile.id,
      actorType: DeliveryActorType.DRIVER,
      actorId: profile.id,
      actorUserId: userId,
      lat: input.lat ?? profile.lastLocation?.lat ?? null,
      lng: input.lng ?? profile.lastLocation?.lng ?? null,
    });
  }

  /**
   * A transition the platform makes, not a driver: `COMPLETED`, and `CANCELLED` from Module 06's
   * `OrderCancelled`.
   *
   * No ownership check, because there is no driver making the request — the caller is the
   * platform. `expectedDriverId` is therefore `null`, and the in-transaction re-read still guards
   * legality and the compare-and-set still guards concurrency.
   */
  async bySystem(input: SystemAdvanceInput): Promise<AdvanceDeliveryJobResult> {
    return this.apply({
      jobId: requireText(input.jobId, 'jobId'),
      to: input.to,
      reason: input.reason ?? null,
      expectedDriverId: null,
      actorType: input.actorType ?? DeliveryActorType.SYSTEM,
      actorId: null,
      actorUserId: input.actorUserId ?? null,
      lat: null,
      lng: null,
    });
  }

  private async apply(params: {
    jobId: string;
    to: DeliveryJobStatus;
    reason: string | null;
    expectedDriverId: string | null;
    actorType: DeliveryActorType;
    actorId: string | null;
    actorUserId: string | null;
    lat: number | null;
    lng: number | null;
  }): Promise<AdvanceDeliveryJobResult> {
    const { jobId, to } = params;
    const reason = normalizeReason(params.reason);

    if (REQUIRES_REASON.includes(to) && reason === null) {
      // A failed delivery with no reason is a dead end for Module 06, which has to decide between
      // a retry, a return and a refund, and for the customer, who is owed an explanation.
      throw DeliveryErrors.validation(`A ${to} transition requires a reason.`, {
        field: 'reason',
        status: to,
      });
    }

    const existing = await this.jobs.findById(jobId);
    if (!existing) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }
    this.assertOwnership(existing, params.expectedDriverId);

    // The idempotent retry, resolved before any transaction is opened. Nothing is written.
    if (existing.status === to) {
      return { job: existing, changed: false };
    }

    return runWithDeliveryRetry(this.uow, async (tx) => {
      const current = await this.jobs.findById(jobId, tx);
      if (!current) {
        throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
      }
      // Re-checked against the row the compare-and-set is about to move: a reassignment may
      // have committed since the read above, and a released driver must not still be able to
      // advance the job.
      this.assertOwnership(current, params.expectedDriverId);
      if (current.status === to) {
        return { job: current, changed: false };
      }

      // The domain decides legality and stamps whichever physical timestamp this transition
      // causes. A backward or skipped move is refused right here.
      //
      // **First**, ahead of the proof check below, and the order matters to the driver holding the
      // handset: a job that has not reached the door cannot be delivered whether or not evidence
      // exists, and answering `POD_REQUIRED` there would send them off to capture proof that
      // `ProofOfDeliveryPolicy` would itself refuse to accept. The state machine is the authority
      // on whether `DELIVERED` is reachable; proof is a further condition on an otherwise-legal
      // transition. Nothing is written by either check, so the reordering costs nothing.
      const next = DeliveryJob.rehydrate(current).transitionTo(to);
      const props = next.toProps();

      // BR-DEL-10's two gates, on the same terms and for the same reasons as BRULE-29's below.
      await this.assertEarningAccrued(current, to, tx);
      await this.assertCodCollected(current, to, tx);

      // BRULE-29's gate, inside the transaction and immediately before the write.
      //
      // Here rather than in the domain because whether *this* delivery needs proof is a
      // configurable business policy that depends on an artifact stored in another table, and
      // `DeliveryStatusPolicy` is a pure state machine that must stay answerable without any I/O.
      //
      // Inside the transaction because the two facts have to agree: a proof committed a
      // millisecond ago must count, and the check must not pass against a row that a concurrent
      // rollback is about to remove. Read here, written two lines later, committed together — so
      // a delivery that requires proof can never be `DELIVERED` without it.
      await this.assertProofOfDelivery(current, to, tx);

      const written = await this.jobs.updateState(
        jobId,
        // Both halves of "nothing moved underneath me": the status the transition was computed
        // from, and — for a driver's post — the driver whose ownership was just checked. A
        // reassignment committing in between changes only the second, and must still lose.
        {
          status: current.status,
          ...(params.expectedDriverId !== null
            ? { assignedDriverId: params.expectedDriverId }
            : {}),
        },
        {
          status: props.status,
          pickedUpAt: props.pickedUpAt,
          deliveredAt: props.deliveredAt,
        },
        tx,
      );
      if (!written) {
        // Somebody changed the job between the read and the write. Which of the two halves of the
        // expectation failed decides the answer — see `resolveLostRace`.
        return this.resolveLostRace(jobId, to, params.expectedDriverId);
      }

      await this.jobs.appendStatusHistory(
        {
          jobId,
          fromStatus: current.status,
          toStatus: props.status,
          actorType: params.actorType,
          actorId: params.actorId,
          reason,
          lat: params.lat,
          lng: params.lng,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: params.actorUserId,
          action: `DELIVERY_JOB_${props.status}`,
          resourceType: 'DeliveryJob',
          resourceId: jobId,
          context: {
            orderId: written.orderId,
            fulfillmentId: written.fulfillmentId,
            from: current.status,
            to: props.status,
            driverId: written.assignedDriverId,
            reason,
          },
        },
        tx,
      );

      const event = this.eventFor(written, reason);
      if (event) {
        await this.outbox.write(event, tx as OutboxCapableClient);
      }

      return { job: written, changed: true };
    });
  }

  /**
   * Decides what a lost compare-and-set means.
   *
   * The expectation has two halves, so losing it has two causes and they need different answers:
   *
   *  - **The driver changed.** A reassignment committed between the ownership check and the write.
   *    The caller no longer holds this job, so they get exactly what they would have got had the
   *    reassignment landed a moment earlier — `NOT_FOUND`, with no hint about where it went.
   *  - **The status changed.** If the job now holds the status the caller asked for, two requests
   *    raced the same transition and this one is the duplicate: success, with nothing written by
   *    this call. Anything else is a genuine conflict and is reported as a refused transition.
   *
   * Checked in that order, because a released driver must not learn what happened to the job.
   */
  private async resolveLostRace(
    jobId: string,
    to: DeliveryJobStatus,
    expectedDriverId: string | null,
  ): Promise<AdvanceDeliveryJobResult> {
    const after = await this.jobs.findById(jobId);
    if (!after) {
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId });
    }
    this.assertOwnership(after, expectedDriverId);
    if (after.status === to) {
      return { job: after, changed: false };
    }
    throw DeliveryErrors.invalidStateTransition(after.status, to);
  }

  /**
   * Refuses a `COMPLETED` transition on a job whose driver earning has not been accrued (§3.5
   * F-ERN-01, BR-DEL-10, §6 of the earnings brief).
   *
   * A no-op for every other target status. Nothing before `COMPLETED` claims the platform has
   * closed its books, and `DELIVERED` deliberately does not — that separation is the status work's,
   * and this gate is what finally gives `COMPLETED` something to mean.
   *
   * ## Why this is a hard prerequisite
   *
   * The status work already wrote the answer, before any of this existed: `DELIVERED → COMPLETED`
   * "is kept as a distinct step rather than collapsed ... `COMPLETED` is the platform closing the
   * job after its settlement-side effects (earnings accrual, COD reconciliation — later works)".
   * The design says the same in §6's flow — `CompleteDelivery → AccrueEarning (idempotent) →
   * DriverEarning(ACCRUED)`. A job that reached `COMPLETED` with no earning would be the platform
   * declaring a delivery closed while the person who made it is owed nothing on record, and
   * `COMPLETED` is terminal — there is no transition out of it and no later pass that would notice.
   *
   * ## What it is *not* waiting for
   *
   * **Payment.** The gate requires the earning to be *accrued*, which is Delivery's own record of
   * what is owed; it does not require Module 07 to have paid it, and it must never come to. Payout
   * depends on settlement runs, a provider, and a funding decision nobody has taken — tying a
   * delivery job's terminal state to any of that would leave jobs open for days over an outage in
   * a module this one does not own (§1, §6).
   *
   * ## Why a refusal here is safe
   *
   * Nothing is written by this check, and it runs before the compare-and-set. A job whose accrual
   * failed therefore stays exactly `DELIVERED` — the physical fact is untouched, no history row is
   * appended, no event is emitted, and the completion can simply be retried once the earning
   * exists (§7). That is the difference between a delivery the platform has not finished
   * processing and a delivery that did not happen, and this module must never confuse the two.
   *
   * Inside the transaction because the two facts have to agree: an earning committed a millisecond
   * ago must count, and the check must not pass against a row a concurrent rollback is about to
   * remove.
   */
  private async assertEarningAccrued(
    job: DeliveryJobProps,
    to: DeliveryJobStatus,
    tx: unknown,
  ): Promise<void> {
    if (to !== DeliveryJobStatus.COMPLETED) {
      return;
    }
    const earning = await this.earnings.findByJobId(job.id, tx);
    if (!earning) {
      throw DeliveryErrors.earningRequired(job.id);
    }
  }

  /**
   * Refuses a `DELIVERED` transition that policy says needs proof the delivery does not have.
   *
   * A no-op for every other target status: proof is evidence of a handover, and no other
   * transition claims one happened.
   *
   * Runs *after* the state machine has accepted the move and *before* anything is written. An
   * illegal transition is reported as one; a legal transition missing its evidence is reported as
   * `POD_REQUIRED`; and in neither case has a row, a history entry or an event been produced.
   *
   * The requirement is resolved from configuration on every call rather than cached, which is
   * deliberate — a compliance team turning the rule on expects the next delivery to obey it, not
   * the next deployment. It is one map lookup.
   *
   * Note what is *not* here: the command does not capture proof, only checks for it. Capture is
   * `CaptureProofOfDeliveryCommand`, reached by its own route, and keeping the two apart is what
   * lets `/deliver` stay the simple idempotent status post the status work built while still being
   * unable to complete a delivery whose evidence is missing.
   */
  /**
   * Refuses a `COMPLETED` transition on a cash-on-delivery job whose collection has not been
   * recorded (§3.5 F-COD-01, BR-DEL-10, §16 of the COD brief).
   *
   * A no-op for every other target status, for every non-COD job, and — by default — for every job
   * at all. See below.
   *
   * ## What this gate asks, and what it refuses to ask
   *
   * It asks only that the collection has been **recorded**: Delivery's own fact, written by the
   * driver at the door. It does **not** ask that the money has reached PharmaLink, that anybody has
   * verified it, or that the pharmacy has been paid. Remittance and reconciliation are slower
   * processes on a cadence the design's Open Question 5 leaves undecided, and Module 07 owns the
   * last leg entirely; a delivery job that stayed open waiting on any of them would be open for
   * days, and `COMPLETED` is terminal.
   *
   * Nor does it touch `DELIVERED`. A physical handover either happened or it did not, and no
   * bookkeeping rule may retract it — §16's separation of the physical fact, the collection record
   * and the financial reconciliation, enforced by the gate simply not existing on that transition.
   *
   * ## Why it ships switched off
   *
   * `requireCollectionForCompletion` defaults to `false`, and the reason is specific to this
   * platform rather than a general preference: **every Slice-1 order is cash on delivery** —
   * `CheckoutCommand` writes `isCod: true` unconditionally — so this rule applies to every delivery
   * on the platform rather than to a subset, and no driver application posts a collection yet.
   * Defaulting it on would strand every delivery at `DELIVERED` from the day it shipped, which is
   * an outage wearing a business rule's clothes.
   *
   * The rule is the right one once collections are actually being posted, which is why the
   * machinery is complete and the switch is an environment variable.
   *
   * ## Why a refusal here is safe
   *
   * Nothing is written by this check and it runs before the compare-and-set, so a job whose COD is
   * unrecorded stays exactly `DELIVERED` — the physical fact untouched, no history row, no event —
   * and the completion is retried once the collection exists.
   *
   * Inside the transaction because the two facts have to agree: a collection committed a
   * millisecond ago must count, and the check must not pass against a row a concurrent rollback is
   * about to remove.
   */
  private async assertCodCollected(
    job: DeliveryJobProps,
    to: DeliveryJobStatus,
    tx: unknown,
  ): Promise<void> {
    if (to !== DeliveryJobStatus.COMPLETED || !job.isCod) {
      return;
    }
    if (!resolveCodSettings(this.config).requireCollectionForCompletion) {
      // The platform's default. No read is issued at all, so every delivery today pays nothing for
      // a rule nobody has turned on.
      return;
    }
    const collection = await this.codCollections.findByJobId(job.id, tx);
    if (!collection) {
      throw DeliveryErrors.codCollectionRequired(job.id);
    }
  }

  private async assertProofOfDelivery(
    job: DeliveryJobProps,
    to: DeliveryJobStatus,
    tx: unknown,
  ): Promise<void> {
    if (to !== DeliveryJobStatus.DELIVERED) {
      return;
    }

    const requirement = ProofOfDeliveryPolicy.requirementFor(
      { isColdChain: job.isColdChain, isCod: job.isCod },
      resolvePodSettings(this.config),
    );
    if (requirement === PodRequirement.None) {
      // The platform's default. No read is issued at all, so the overwhelmingly common delivery
      // pays nothing for a policy nobody has turned on.
      return;
    }

    const proof = await this.proofs.findByJobId(job.id, tx);
    if (!ProofOfDeliveryPolicy.isSatisfiedBy(requirement, proof)) {
      throw DeliveryErrors.proofOfDeliveryRequired(job.id, requirement);
    }
  }

  private assertOwnership(job: DeliveryJobProps, expectedDriverId: string | null): void {
    if (expectedDriverId === null) {
      return;
    }
    if (job.assignedDriverId !== expectedDriverId) {
      // Not `FORBIDDEN`: a driver must not be able to tell "that job is somebody else's" from
      // "there is no such job".
      throw DeliveryErrors.notFound('Delivery job not found.', { jobId: job.id });
    }
  }

  /**
   * The event a transition publishes, or `null` where the catalogue defines none.
   *
   * `ARRIVED_PICKUP` and `ARRIVED_DROPOFF` are deliberately silent: the catalogue has no event
   * for either, no module is waiting on them, and they are the driver's progress rather than a
   * change in what is true about the order. They are still recorded in history, which is where a
   * question about them would be answered. `COMPLETED` is silent for the same reason — Module 06
   * publishes its own `OrderCompleted` about its own aggregate.
   */
  private eventFor(
    job: DeliveryJobProps,
    reason: string | null,
  ): DomainEvent<DeliveryStatusPayload> | null {
    const payload: DeliveryStatusPayload = {
      jobId: job.id,
      orderId: job.orderId,
      fulfillmentId: job.fulfillmentId,
      driverId: job.assignedDriverId ?? '',
      status: job.status,
    };

    switch (job.status) {
      case DeliveryJobStatus.PICKED_UP:
        return orderPickedUpEvent(payload);
      case DeliveryJobStatus.EN_ROUTE:
        return enRouteEvent(payload);
      case DeliveryJobStatus.DELIVERED:
        return orderDeliveredEvent(payload);
      case DeliveryJobStatus.FAILED:
        return deliveryFailedEvent({ ...payload, reason: reason ?? 'UNSPECIFIED' });
      default:
        return null;
    }
  }
}

const MAX_REASON_LENGTH = 280;

function normalizeReason(reason: string | null): string | null {
  if (typeof reason !== 'string') {
    return null;
  }
  const text = reason.trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length > MAX_REASON_LENGTH) {
    throw DeliveryErrors.validation(
      `reason must be at most ${MAX_REASON_LENGTH} characters.`,
      { field: 'reason' },
    );
  }
  return text;
}

function requireText(value: string, field: string): string {
  const text = (value ?? '').trim();
  if (!text) {
    throw DeliveryErrors.validation(`${field} is required.`, { field });
  }
  return text;
}
