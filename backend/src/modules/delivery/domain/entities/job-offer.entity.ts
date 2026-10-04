import { JobOfferStatus } from '../enums';
import { DeliveryErrors } from '../errors';

/** Why an offer ended, where the ending was not a driver's own words. */
export const OFFER_EXPIRY_REASON = 'TTL_EXPIRED';

/** Bound on a stored decline reason — free text from a handset, so it needs one. */
export const MAX_OFFER_REASON_LENGTH = 280;

/**
 * The persisted shape of a job offer (§5.1's `JobOffer`, §8's `job_offers`).
 *
 * Both references are Module 08's own, so unlike the job's cross-context ids these are real
 * foreign keys: `jobId` is a `delivery_jobs.id` and `driverId` a `driver_profiles.id` — the same
 * reference `DeliveryJob.assignedDriverId` carries, so an offer and the assignment it produces
 * name the same thing rather than two ids that have to be reconciled.
 */
export interface JobOfferProps {
  id: string;
  jobId: string;
  /** `driver_profiles.id`, never a Module 01 `users.id`. */
  driverId: string;
  status: JobOfferStatus;
  offeredAt: Date;
  /** **Authoritative.** See `isExpiredAt`. */
  expiresAt: Date;
  respondedAt: Date | null;
  reason: string | null;
  /** 1-based dispatch attempt for this job. Unique per job, by index. */
  round: number;
}

export interface NewJobOfferInput {
  id: string;
  jobId: string;
  driverId: string;
  round: number;
  ttlSeconds: number;
  now?: Date;
}

/**
 * `JobOffer` — one offer of one job to one driver, with a deadline (§3.2 F-JOB-04, §6.3).
 *
 * ## Three ways to end, and no more
 *
 * ```
 * OFFERED ──► ACCEPTED   the driver took it
 *         ──► DECLINED   the driver refused it
 *         ──► EXPIRED    nobody answered in time
 * ```
 *
 * All three are terminal. The design's §5.2 lists exactly these four values and no others, and
 * nothing here adds a fifth: a "cancelled" offer, for instance, would be indistinguishable in
 * practice from an expired one and would give two names to the same fact. An offer is never
 * deleted and never reopened — it is the record of a question that was asked, and the answer is
 * what a dispute about a late delivery is reconstructed from.
 *
 * ## Expiry is a comparison, not an event
 *
 * `expiresAt` is stored and compared against the clock on every read (`isExpiredAt`). It is
 * deliberately **not** a scheduled callback or an in-memory timer, because those can be missed:
 * a process restart, a paused worker or a machine that slept must not be able to leave an offer
 * acceptable past its deadline. A sweeper that flips expired rows to `EXPIRED` is useful for
 * keeping the table tidy and for driving re-dispatch promptly, but it is an optimisation of
 * *when* the transition is recorded, never the authority on *whether* the offer is live.
 *
 * This is why `accept` takes a clock: the decision is made from the stored deadline at the moment
 * of the attempt, so an offer whose row still says `OFFERED` is still refused once the deadline
 * has passed.
 *
 * ## Immutability
 *
 * Every mutator returns a **new** `JobOffer`, as `DeliveryJob` and `DriverProfile` both do. A
 * refused response leaves the caller's instance untouched.
 */
export class JobOffer {
  private constructor(private readonly props: JobOfferProps) {}

  /**
   * Creates a live offer with its deadline already set.
   *
   * The TTL is passed in rather than read here: it is `delivery.offerTtlSeconds`, an application
   * concern reached through `IConfigPort`, and a domain entity that read configuration would be
   * doing I/O. What the entity owns is that the deadline is computed once, at creation, and never
   * recomputed — an offer whose expiry drifted with the config would be a deadline nobody agreed
   * to.
   */
  static create(input: NewJobOfferInput): JobOffer {
    const now = input.now ?? new Date();
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw DeliveryErrors.validation('ttlSeconds must be a positive whole number.', {
        field: 'ttlSeconds',
        value: input.ttlSeconds,
      });
    }
    if (!Number.isInteger(input.round) || input.round < 1) {
      throw DeliveryErrors.validation('round must be a whole number of at least 1.', {
        field: 'round',
        value: input.round,
      });
    }
    return new JobOffer({
      id: requireText(input.id, 'id'),
      jobId: requireText(input.jobId, 'jobId'),
      driverId: requireText(input.driverId, 'driverId'),
      status: JobOfferStatus.OFFERED,
      offeredAt: now,
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
      respondedAt: null,
      reason: null,
      round: input.round,
    });
  }

  /** Rebuilds from persistence, re-checking the invariants. */
  static rehydrate(props: JobOfferProps): JobOffer {
    const offer = new JobOffer({ ...props });
    offer.assertConsistent();
    return offer;
  }

  get id(): string {
    return this.props.id;
  }
  get jobId(): string {
    return this.props.jobId;
  }
  get driverId(): string {
    return this.props.driverId;
  }
  get status(): JobOfferStatus {
    return this.props.status;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get round(): number {
    return this.props.round;
  }

  /** Still awaiting an answer — says nothing about the deadline. See `isLiveAt`. */
  get isPending(): boolean {
    return this.props.status === JobOfferStatus.OFFERED;
  }

  /**
   * Past its deadline.
   *
   * Strictly greater than: an answer arriving exactly on the deadline is in time. The boundary has
   * to fall somewhere, and giving it to the driver is the direction that cannot cost anyone a
   * delivery — an offer accepted on the last millisecond is a job placed, while one refused there
   * is a job that goes round the candidate list again.
   */
  isExpiredAt(now: Date): boolean {
    return now.getTime() > this.props.expiresAt.getTime();
  }

  /** Pending *and* within its deadline — the only state in which an offer may be answered. */
  isLiveAt(now: Date): boolean {
    return this.isPending && !this.isExpiredAt(now);
  }

  /**
   * The driver takes the job.
   *
   * Refuses an offer that is already answered, and one past its deadline. Both refusals are also
   * enforced outside this aggregate — by a compare-and-set on the row, which is what makes two
   * simultaneous accepts resolve to one winner — but they are stated here too, because a rule
   * that lives only in a `WHERE` clause is a rule nobody can read.
   */
  accept(now: Date = new Date()): JobOffer {
    this.assertAnswerable(now);
    return this.with({ status: JobOfferStatus.ACCEPTED, respondedAt: now });
  }

  /** The driver refuses the job, optionally saying why (§13's reassignment/decline trail). */
  decline(reason: string | null = null, now: Date = new Date()): JobOffer {
    this.assertAnswerable(now);
    return this.with({
      status: JobOfferStatus.DECLINED,
      respondedAt: now,
      reason: normalizeReason(reason),
    });
  }

  /**
   * Nobody answered in time.
   *
   * `respondedAt` stays **null**: it records when the *driver* responded, and the whole point of
   * an expiry is that they did not. The moment of expiry is already knowable from `expiresAt`,
   * and writing a response time for a response that never came would make the two
   * indistinguishable in the trail.
   *
   * Requires the deadline to have actually passed. Retiring a live offer early would be a way to
   * take a job away from a driver who still had time to accept it, and it would open a window in
   * which they accept while the dispatcher is already offering somebody else.
   */
  expire(now: Date = new Date()): JobOffer {
    if (!this.isPending) {
      throw DeliveryErrors.availabilityConflict(
        `A ${this.props.status} offer cannot expire.`,
        { offerId: this.props.id, status: this.props.status },
      );
    }
    if (!this.isExpiredAt(now)) {
      throw DeliveryErrors.availabilityConflict(
        'This offer has not reached its expiry time.',
        { offerId: this.props.id, expiresAt: this.props.expiresAt.toISOString() },
      );
    }
    return this.with({ status: JobOfferStatus.EXPIRED, reason: OFFER_EXPIRY_REASON });
  }

  toProps(): JobOfferProps {
    return { ...this.props };
  }

  private assertAnswerable(now: Date): void {
    if (!this.isPending) {
      throw DeliveryErrors.jobAlreadyAssigned(this.props.jobId, this.props.status);
    }
    if (this.isExpiredAt(now)) {
      throw DeliveryErrors.offerExpired(this.props.id, this.props.expiresAt);
    }
  }

  private assertConsistent(): void {
    if (this.props.expiresAt.getTime() <= this.props.offeredAt.getTime()) {
      throw DeliveryErrors.validation('expiresAt must be after offeredAt.', {
        field: 'expiresAt',
      });
    }
    // An answered offer must say when, and a pending one must not — otherwise a row could claim a
    // driver responded to a question still being asked.
    const answered =
      this.props.status === JobOfferStatus.ACCEPTED ||
      this.props.status === JobOfferStatus.DECLINED;
    if (answered && this.props.respondedAt === null) {
      throw DeliveryErrors.validation(`A ${this.props.status} offer must have respondedAt.`, {
        field: 'respondedAt',
      });
    }
    if (this.props.status === JobOfferStatus.OFFERED && this.props.respondedAt !== null) {
      throw DeliveryErrors.validation('A pending offer must not have respondedAt.', {
        field: 'respondedAt',
      });
    }
    if (!Number.isInteger(this.props.round) || this.props.round < 1) {
      throw DeliveryErrors.validation('round must be a whole number of at least 1.', {
        field: 'round',
      });
    }
  }

  private with(patch: Partial<JobOfferProps>): JobOffer {
    const next = new JobOffer({ ...this.props, ...patch });
    next.assertConsistent();
    return next;
  }
}

function normalizeReason(reason: string | null): string | null {
  if (typeof reason !== 'string') {
    return null;
  }
  const text = reason.trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length > MAX_OFFER_REASON_LENGTH) {
    throw DeliveryErrors.validation(
      `reason must be at most ${MAX_OFFER_REASON_LENGTH} characters.`,
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
