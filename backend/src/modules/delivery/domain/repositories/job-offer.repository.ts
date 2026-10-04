import { JobOfferProps } from '../entities/job-offer.entity';
import { JobOfferStatus } from '../enums';

export const JOB_OFFER_REPOSITORY = Symbol('JOB_OFFER_REPOSITORY');

/** The fields an answered offer writes. The status decides which of the others apply. */
export interface JobOfferResponseUpdate {
  status: JobOfferStatus;
  respondedAt: Date | null;
  reason: string | null;
}

/**
 * Persistence port for the `JobOffer` aggregate (§5.1, §8's `job_offers`).
 *
 * Domain snapshots in, domain snapshots out — no Prisma type crosses this boundary (ADR-002).
 *
 * There is deliberately **no delete**. An offer is the record of a question the platform asked a
 * driver; a job that took four rounds to place is a fact an operator needs to be able to see, and
 * the offers are the only place it is written down.
 */
export interface IJobOfferRepository {
  findById(id: string, tx?: unknown): Promise<JobOfferProps | null>;

  /**
   * The job's live (`OFFERED`) offer, if it has one.
   *
   * At most one can exist — the partial unique index `job_offers_one_live_per_job` makes that a
   * database guarantee rather than a convention — so this returns a single row rather than a
   * list. Note that "live" here means *pending*, not *within its deadline*: an expired-but-not-
   * yet-swept offer still occupies the slot, and the caller compares `expiresAt` to decide what
   * to do with it.
   */
  findPendingForJob(jobId: string, tx?: unknown): Promise<JobOfferProps | null>;

  /** Every offer ever made for a job, newest round first — the dispatch history (§13). */
  listForJob(jobId: string, tx?: unknown): Promise<JobOfferProps[]>;

  /**
   * The highest round number this job has reached, or `0` when it has never been offered.
   *
   * The next offer is `round + 1`, and `(jobId, round)` is unique, so two dispatchers racing the
   * same round cannot both insert — one gets a `P2002` and re-reads, which is what makes a
   * retried dispatch converge rather than stack offers.
   */
  maxRoundForJob(jobId: string, tx?: unknown): Promise<number>;

  create(offer: JobOfferProps, tx?: unknown): Promise<JobOfferProps>;

  /**
   * Answers an offer, but **only while it is still pending**.
   *
   * A compare-and-set on `status`, returning `null` when the row has already moved. This is the
   * mechanism — not the aggregate's own check — that makes two simultaneous accepts resolve to
   * one winner: Postgres either matches the row in `OFFERED` or matches nothing, and `null` tells
   * the caller they lost rather than letting a second accept overwrite the first.
   */
  respond(
    id: string,
    update: JobOfferResponseUpdate,
    tx?: unknown,
  ): Promise<JobOfferProps | null>;

  /**
   * Pending offers whose deadline has passed, oldest first.
   *
   * The unlocked read. `OfferExpirySweeper` uses `lockNextExpired` instead — this one remains for
   * diagnostics and for tests that want to observe the backlog without consuming it.
   */
  listExpired(now: Date, limit: number, tx?: unknown): Promise<JobOfferProps[]>;

  /**
   * The live, unexpired offers currently addressed to one driver, soonest deadline first.
   *
   * The REST fallback behind `GET /driver/jobs`'s "offered" half. Expiry is applied in the query
   * rather than by the caller because a lapsed offer is not something a driver should be shown at
   * all — it is a question that has closed, and rendering it invites a tap that can only fail.
   *
   * Scoped to one `driver_profiles.id`, which the caller resolves from the access token; there is
   * no shape of this call that returns another driver's offers.
   */
  listPendingForDriver(
    driverId: string,
    now: Date,
    limit: number,
    tx?: unknown,
  ): Promise<JobOfferProps[]>;

  /**
   * Locks and returns the oldest pending offer whose deadline has passed, or `null`.
   *
   * `FOR UPDATE SKIP LOCKED`, inside the caller's transaction and as its **first** statement —
   * the same shape as `IReservationRepository.lockNextExpired`, for the same reason. Two sweepers
   * on two application instances therefore never see the same row: one locks it, the other skips
   * past to the next candidate instead of blocking behind it. Without the lock both would read
   * the row, both would call dispatch, and the partial unique index would turn a routine overlap
   * into an error one of them has to recover from.
   *
   * `excludeIds` lets a single tick step over a row it has already failed on, so one permanently
   * broken offer — always the oldest, therefore always selected first — cannot starve the rest of
   * the batch.
   *
   * `tx` is required, not optional: a row lock outside a transaction is released immediately and
   * would be a silent no-op.
   */
  lockNextExpired(
    now: Date,
    excludeIds: readonly string[],
    tx: unknown,
  ): Promise<JobOfferProps | null>;
}
