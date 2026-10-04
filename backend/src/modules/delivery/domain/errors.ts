import { ApiException } from '../../../shared/errors/api-exception';
import { ErrorCode } from '../../../shared/errors/error-codes';

/**
 * Delivery domain/application errors (`architecture/module-08-delivery-tracking.md` §12). Thrown
 * from the domain and application layers and translated to the standard error envelope by the
 * global `AllExceptionsFilter`, mirroring `OrdersErrors`/`PaymentErrors` and their Module 04/05
 * siblings.
 *
 * §12 names seven module-specific codes. **Only the ones this foundation can actually throw are
 * defined here**, because the shared error catalogue is append-only and a code is added when its
 * thrower exists, never speculatively — the rule Module 07's own catalogue comment states. The
 * rest arrive with the work that raises them:
 *
 *  - `CONCURRENT_LIMIT_REACHED` (BRULE-28), `OFFER_EXPIRED` and `JOB_ALREADY_ASSIGNED` arrive
 *    with the dispatch work, which is the first to have an accept path that can raise them.
 *  - `NO_DRIVER_AVAILABLE` is **still absent**, and deliberately so. Dispatch exhaustion is not
 *    an exception here: `DispatchDeliveryJobCommand` returns `DispatchOutcome.NoCandidate` and
 *    leaves the job dispatchable, because its caller is an event handler with nobody to report a
 *    throw to — a job that failed loudly into a bus that cannot retry would be a job nobody was
 *    looking for. The code arrives with the first caller who can act on it.
 *  - `POD_REQUIRED` (BRULE-29) — the proof-of-delivery work.
 *  - `RBAC_FORBIDDEN` already exists and is raised by the global guard, not by this module.
 *
 * `FULFILLMENT_NOT_DELIVERABLE` is added by the job-creation work. §12 does not name it — §12
 * lists the driver-facing failures — but BRULE-27's precondition needs a refusal a caller can
 * distinguish from a validation slip or a missing row.
 *
 * `DRIVER_NOT_VERIFIED` (BRULE-09) is added by the driver-operational-profile work, the first
 * with a verification gate to fail.
 */
export const DeliveryErrors = {
  validation: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.VALIDATION_ERROR, message, details),

  /**
   * Generic not-found for delivery-job lookups. Reuses the shared `NOT_FOUND` code exactly as
   * `OrdersErrors.notFound()`/`CatalogErrors.notFound()` do, rather than minting a
   * `DELIVERY_JOB_NOT_FOUND`: no route exists yet, and a scoping mismatch must be reported
   * identically to a genuine miss (no existence leakage, `00-shared-conventions.md` §1).
   */
  notFound: (message = 'Delivery job not found.', details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, message, details),

  /**
   * BRULE-27's gate: a job may be created only from a fulfillment that is actually ready for
   * delivery.
   *
   * Module 08 does not decide what "ready" means and does not hold a copy of Module 06's state
   * machine — `IOrdersPort` reports eligibility and this error reports the refusal. The current
   * status travels in `details` so an operator can see *why* without Module 08 having to
   * interpret it.
   */
  fulfillmentNotDeliverable: (fulfillmentId: string, status: string | null) =>
    new ApiException(
      ErrorCode.FULFILLMENT_NOT_DELIVERABLE,
      status === null
        ? 'Fulfillment not found.'
        : `Fulfillment ${fulfillmentId} is not ready for delivery (status ${status}).`,
      { fulfillmentId, status },
    ),

  /**
   * §12's `INVALID_STATE_TRANSITION`, named for this module's aggregate.
   *
   * Follows the established one-transition-code-per-aggregate convention
   * (`INVALID_ORDER_STATE_TRANSITION`, `INVALID_PAYMENT_STATE_TRANSITION`,
   * `INVALID_PRESCRIPTION_STATE_TRANSITION`): the F-STS-01 state machine gets its own code rather
   * than borrowing Module 06's, because a delivery job is a separate aggregate root in a separate
   * bounded context and a client must be able to tell which state machine refused.
   */
  invalidStateTransition: (from: string, to: string) =>
    new ApiException(
      ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      `Cannot transition delivery job status from ${from} to ${to}.`,
      { from, to, aggregate: 'deliveryJob' },
    ),

  /**
   * A driver's requested availability or shift change contradicts their current operational state.
   *
   * Reuses the shared `CONFLICT` (409) rather than minting an
   * `INVALID_DRIVER_AVAILABILITY_TRANSITION`, and the distinction from `invalidStateTransition`
   * above is deliberate. §12 names an illegal *job* transition and this module gives that its own
   * aggregate-qualified code because a client must know which state machine refused. Availability
   * is not a state machine: it is a single invariant (working requires an open shift) plus one
   * rule about who may set `BUSY`. 409 already says exactly what is true — the request is
   * well-formed and the current state is what refuses it — and the catalogue is append-only
   * precisely so that codes are not added for shapes an existing one already describes.
   */
  availabilityConflict: (message: string, details?: unknown) =>
    new ApiException(ErrorCode.CONFLICT, message, details),

  /**
   * BRULE-29: this delivery needs proof and does not have it (§3.3 F-STS-04, §12's
   * `POD_REQUIRED`).
   *
   * Its own code rather than a generic conflict because the driver's app has a specific, actionable
   * thing to say: the delivery is fine, the state machine would allow it, and what is missing is a
   * signature or a photograph they can still go and take. `INVALID_DELIVERY_STATE_TRANSITION` would
   * send them looking for a state problem that does not exist.
   *
   * The requirement travels in `details` so the app can put up the right capture screen instead of
   * guessing which of the three forms of proof will satisfy the policy.
   */
  proofOfDeliveryRequired: (jobId: string, requirement: string) =>
    new ApiException(
      ErrorCode.POD_REQUIRED,
      'This delivery requires proof of delivery before it can be completed.',
      { jobId, requirement },
    ),

  /**
   * Proof offered for a delivery that is not at the point of handover (§9 of the PoD brief).
   *
   * Reuses the shared `CONFLICT` and adds no code, for the reason `availabilityConflict` sets out:
   * the request is well-formed and the caller is entitled to make it, and it is the job's current
   * state that refuses. The status travels in `details` so a driver's app can say "post your
   * arrival first" rather than retrying a submission that cannot be accepted where the job stands.
   */
  proofOfDeliveryNotAcceptable: (jobId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `Delivery job ${jobId} is not at the point of handover (status ${status}).`,
      { jobId, status },
    ),

  /**
   * An attempt to replace evidence that has already been accepted (§7's immutability).
   *
   * Distinct from the idempotent retry, which succeeds silently: a resubmission carrying *the same*
   * evidence is the handset retrying and is answered with the stored record. This is a
   * resubmission carrying *different* evidence, which is a request to overwrite a delivery's proof,
   * and the only honest answer is to refuse rather than to keep the first and report success.
   */
  proofOfDeliveryAlreadyCaptured: (jobId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This delivery already has proof of delivery, which cannot be replaced.',
      { jobId },
    ),

  /**
   * A position report against a job that is not in a trackable state (§7, F-TRK-01).
   *
   * **Reuses the shared `CONFLICT` (409), and adds no code**, for the reason
   * `availabilityConflict` above sets out. The error catalogue is append-only and a code is added
   * when an existing one genuinely cannot describe the refusal; here 409 says precisely what is
   * true — the request is well-formed, the caller is who they say they are, and it is the job's
   * current state that refuses it. `INVALID_DELIVERY_STATE_TRANSITION` would be wrong rather than
   * merely redundant: nothing was asked to transition, and a client reading that code would go
   * looking for a state machine move it never requested.
   *
   * The current status travels in `details` so a driver app can tell "this delivery is finished"
   * from "you have not picked up yet" and stop posting, rather than retrying a report that can
   * never be accepted.
   */
  locationNotAcceptable: (jobId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `Delivery job ${jobId} is not accepting location updates (status ${status}).`,
      { jobId, status },
    ),

  /**
   * BRULE-09: only verified, onboarded drivers may become operationally eligible.
   *
   * **Module 08 does not decide this and holds no copy of the answer.** `IIdentityPort` reads
   * Module 01's `users` and `verification_requests` live at the moment of the check; this error
   * only reports the refusal. `reason` travels in `details` so an operator — and the driver app —
   * can tell "your documents are still pending" from "your account is suspended" without Module
   * 08 having to model either.
   *
   * It **fails closed**: a driver Module 01 has no record of is refused, never assumed eligible.
   */
  driverNotVerified: (userId: string, reason: string) =>
    new ApiException(
      ErrorCode.DRIVER_NOT_VERIFIED,
      'This driver is not verified to take deliveries.',
      { userId, reason },
    ),

  /**
   * A driver operational profile that does not exist. Reuses shared `NOT_FOUND` for the same
   * reason `notFound` above does — no existence leakage, and no route yet to leak from.
   */
  driverProfileNotFound: (details?: unknown) =>
    new ApiException(
      ErrorCode.NOT_FOUND,
      'Driver operational profile not found.',
      details,
    ),

  /**
   * A job offer that does not exist, or does not belong to the caller.
   *
   * **One error for both**, reusing the shared `NOT_FOUND` exactly as `notFound` above does. A
   * driver who guessed another driver's offer id must not be able to tell "that offer is not
   * yours" from "there is no such offer": the first answer confirms the offer exists and turns
   * the id space into an oracle for who is being dispatched what
   * (`00-shared-conventions.md` §1's no-existence-leakage rule).
   */
  offerNotFound: (details?: unknown) =>
    new ApiException(ErrorCode.NOT_FOUND, 'Job offer not found.', details),

  /**
   * §12's `OFFER_EXPIRED` — the driver answered after the TTL.
   *
   * Its own code rather than a generic conflict because the driver's app has a specific thing to
   * say: the job is gone and it was a timing problem, not a competition they lost. The deadline
   * that decided this is the stored `expiresAt`, compared at the moment of the attempt.
   */
  offerExpired: (offerId: string, expiresAt: Date) =>
    new ApiException(ErrorCode.OFFER_EXPIRED, 'This job offer has expired.', {
      offerId,
      expiresAt: expiresAt.toISOString(),
    }),

  /**
   * BRULE-28, §12's `CONCURRENT_LIMIT_REACHED` — the driver already holds their maximum.
   *
   * Checked **at acceptance**, not merely when the offer was made: §11.2 puts the guard inside
   * the accept transaction, and the gap between the two is exactly long enough for the driver to
   * have accepted something else.
   */
  concurrentLimitReached: (activeJobCount: number, limit: number) =>
    new ApiException(
      ErrorCode.CONCURRENT_LIMIT_REACHED,
      'You are already carrying the maximum number of deliveries.',
      { activeJobCount, limit },
    ),

  /**
   * §12's `JOB_ALREADY_ASSIGNED` — "race on offer", in §12's own words.
   *
   * Raised when the job moved on beneath the accept: another driver won it, it was cancelled, or
   * a reassignment retired the offer. Distinct from `offerExpired` because nothing the driver
   * could have done faster would have helped, and distinct from `invalidStateTransition` because
   * the caller is a driver's handset, not a state machine's client.
   */
  jobAlreadyAssigned: (jobId: string, status: string) =>
    new ApiException(
      ErrorCode.JOB_ALREADY_ASSIGNED,
      'This delivery has already been taken.',
      { jobId, status },
    ),

  /**
   * The job is in a state from which dispatch cannot proceed.
   *
   * Reuses the aggregate's own `INVALID_DELIVERY_STATE_TRANSITION` rather than minting a
   * `JOB_NOT_DISPATCHABLE`: "this job cannot be offered from `DELIVERED`" *is* a refused
   * transition, and §12 already names one code for that.
   */
  jobNotDispatchable: (jobId: string, status: string) =>
    new ApiException(
      ErrorCode.INVALID_DELIVERY_STATE_TRANSITION,
      `Delivery job ${jobId} cannot be dispatched from ${status}.`,
      { jobId, status, aggregate: 'deliveryJob' },
    ),

  /**
   * The routing provider was asked for a distance and could not answer, so there is no fee (§10 of
   * the delivery-fee brief, F-FEE-01).
   *
   * Reuses the shared `DEPENDENCY_UNAVAILABLE` (503), which is precisely the convention Module 07
   * already established for an external provider whose answer never arrived: `AuthorizePayment`
   * leaves the payment `INITIATED` and raises this rather than recording an outcome it is not sure
   * of. The same reasoning applies to a price. A quote that silently fell back to a zero fee, or
   * to a straight-line guess, would be the platform inventing a number and presenting it to a
   * customer as what they owe — and unlike a missing ETA, which degrades a map, a wrong fee is
   * money.
   *
   * 503 rather than a 4xx because nothing about the request is wrong: the caller may retry it
   * unchanged the moment the provider is back, and an infrastructure failure is not the customer's
   * mistake to be told about in the second person.
   *
   * No new code is added to the catalogue, which is append-only: one already says exactly this.
   */
  routingUnavailable: (details?: unknown) =>
    new ApiException(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'A delivery quote is temporarily unavailable because the route could not be calculated.',
      details,
    ),

  /**
   * The earning agreement charges by distance and the delivery has none recorded (§10 of the
   * earnings brief, F-ERN-01).
   *
   * Reuses the shared `BUSINESS_RULE_VIOLATION` (422) rather than minting a code: the request is
   * well-formed and the caller is entitled to make it, and what refuses it is a rule about the
   * data — precisely what 422 says, and what `availabilityConflict` and
   * `proofOfDeliveryNotAcceptable` already establish as this module's habit with the append-only
   * catalogue.
   *
   * **Retriable, and that is the point.** The delivery job keeps its `DELIVERED` status, no earning
   * is written, and nothing is fabricated to fill the gap — no fresh route is measured and the
   * missing distance is not silently read as zero. An operator who backfills the distance, or who
   * sets the per-kilometre rate to zero, can re-run the accrual and it will succeed. What must not
   * happen is a driver being paid for a journey the platform measured after the fact between places
   * they are no longer at.
   */
  earningDistanceUnavailable: (jobId: string, calculationVersion: string) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'This delivery has no recorded distance, which the current earning agreement requires.',
      { jobId, calculationVersion },
    ),

  /**
   * An earning was requested for a delivery that has not reached the point of earning one.
   *
   * Reuses the shared `CONFLICT` for the reason `availabilityConflict` sets out: the request is
   * well-formed, and it is the job's current state that refuses it. The status travels in
   * `details` so an operator can see how far the delivery actually got.
   */
  earningNotAccruable: (jobId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `Delivery job ${jobId} has not been delivered (status ${status}).`,
      { jobId, status },
    ),

  /**
   * A `COMPLETED` transition attempted on a job whose earning has not been accrued (§6).
   *
   * `COMPLETED` is the platform closing its own books on a delivery, and the earnings ledger is
   * half of what "closed" means — so a job cannot reach it with its driver unpaid-for. Shared
   * `CONFLICT` again, and no new code: the caller here is the platform's own completion path, not
   * a driver's handset, so there is no app that needs a specific instruction to act on.
   *
   * It does **not** mean the driver has been paid. Payment is Module 07's, and `COMPLETED`
   * deliberately does not wait on it — only on the accrual that tells Module 07 what to pay.
   */
  earningRequired: (jobId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This delivery cannot be completed until its driver earning has been accrued.',
      { jobId },
    ),

  /**
   * A COD collection offered for a delivery that is not at the point of handover (§6 of the COD
   * brief, F-COD-01).
   *
   * Reuses the shared `CONFLICT` for the reason `proofOfDeliveryNotAcceptable` sets out: the
   * request is well-formed and the caller is entitled to make it, and it is the job's current state
   * that refuses. The status travels in `details` so a driver's app can say "post your arrival
   * first" rather than retrying a submission that cannot be accepted where the job stands.
   */
  codCollectionNotAcceptable: (jobId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `Delivery job ${jobId} is not at the point of handover (status ${status}).`,
      { jobId, status },
    ),

  /**
   * A COD collection offered for a delivery that is not cash on delivery at all.
   *
   * Distinct from the stage refusal because the answer is different in kind: no amount of waiting
   * or re-posting will make this job collectable, and a driver's app should stop rather than retry.
   */
  codNotApplicable: (jobId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This delivery is not cash on delivery, so there is nothing to collect.',
      { jobId },
    ),

  /**
   * An attempt to replace a collection that has already been recorded (§15's immutability).
   *
   * Distinct from the idempotent retry, which succeeds silently: a resubmission carrying *the same*
   * declaration is the handset retrying and is answered with the stored record. This is a
   * resubmission carrying a **different amount, method or reference** — a request to restate how
   * much cash changed hands — and the only honest answer is to refuse rather than to keep the first
   * and report success.
   */
  codCollectionAlreadyRecorded: (jobId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This delivery already has a recorded COD collection, which cannot be replaced.',
      { jobId },
    ),

  /**
   * The declared amount does not match the order total and the operator requires that it does.
   *
   * `BUSINESS_RULE_VIOLATION` (422) rather than a validation error: the request is well-formed and
   * the number in it may well be exactly what the driver was handed — what refuses it is a
   * commercial rule an operator switched on, not a malformed field.
   *
   * **Only reachable when `delivery.codRequireExactAmount` is set.** The shipped default records
   * the discrepancy instead, because refusing by default would invent an exact-payment policy no
   * approved document states, and would push a driver towards typing the expected figure rather
   * than the true one.
   */
  codAmountMismatch: (jobId: string, expectedAmount: number, collectedAmount: number) =>
    new ApiException(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      'The collected amount does not match the amount due for this delivery.',
      { jobId, expectedAmount, collectedAmount },
    ),

  /**
   * A `COMPLETED` transition attempted on a COD delivery with no recorded collection (§16).
   *
   * Shared `CONFLICT`, no new code, for the reason `earningRequired` gives: the caller is the
   * platform's own completion path rather than a driver's handset, so there is no app that needs a
   * specific instruction to act on.
   *
   * It does **not** mean the money has reached PharmaLink, and must never come to. The gate asks
   * only that the collection has been *recorded* — Delivery's own fact. Remittance and
   * reconciliation are later, slower processes, and tying a delivery job's terminal state to them
   * would leave jobs open for days over a cash-handling cadence nobody has defined.
   */
  codCollectionRequired: (jobId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This cash-on-delivery job cannot be completed until its collection has been recorded.',
      { jobId },
    ),

  /**
   * A remittance confirmed against a collection that is not waiting for one (§1, §5).
   *
   * Shared `CONFLICT` and no new code, for the reason `codCollectionNotAcceptable` gives: the
   * request is well-formed and the caller is entitled to make it, and it is the collection's
   * current state that refuses. The status travels in `details` so a finance console can say
   * "this was already remitted on the 3rd" rather than offering a retry that cannot succeed.
   *
   * Reached only when the states genuinely disagree. A repeat of the *same* confirmation is an
   * idempotent replay and returns the stored remittance — see `RecordCodRemittanceCommand`.
   */
  codRemittanceNotAllowed: (collectionId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `COD collection ${collectionId} is not awaiting remittance (status ${status}).`,
      { collectionId, status },
    ),

  /**
   * A reconciliation attempted on a collection that has not been remitted (§5's required boundary).
   *
   * **This is the error that makes `COLLECTED → RECONCILED` unreachable.** It is not a validation
   * nicety: reconciling a collection nobody has handed over would be PharmaLink certifying money
   * it does not hold, on the word of the channel holding it, and no permission check substitutes
   * for refusing it outright.
   */
  codReconciliationNotAllowed: (collectionId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `COD collection ${collectionId} cannot be reconciled from status ${status}; it must be remitted first.`,
      { collectionId, status },
    ),

  /**
   * A second, *different* remittance offered for a collection that already has one (§8).
   *
   * Distinct from the idempotent replay, which succeeds silently: a repeat carrying the same
   * amount, currency, reference and note is a console retrying and is answered with the stored
   * row. This is a repeat carrying a **different figure or reference** — a request to overwrite
   * what the platform recorded receiving — and §8 forbids it outright. Refusing is the only honest
   * answer; keeping the first and reporting success would leave an operator believing their
   * correction had landed.
   */
  codRemittanceAlreadyRecorded: (collectionId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This COD collection already has a recorded remittance, which cannot be replaced.',
      { collectionId },
    ),

  /**
   * A second, *different* reconciliation offered for a collection that already has one (§8, §12).
   *
   * Same distinction as `codRemittanceAlreadyRecorded`, and one more reason besides: §12 requires
   * that a repeat can never move a collection backward out of `RECONCILED`. A replay returns the
   * committed finding; anything that would restate it is refused, because deleting or rewriting
   * reconciliation history is exactly what §8 rules out.
   */
  codReconciliationAlreadyRecorded: (collectionId: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This COD collection has already been reconciled, and the finding cannot be replaced.',
      { collectionId },
    ),

  /**
   * A remittance or reconciliation naming a collection that does not exist (§1's "remittance
   * requires an existing collection").
   *
   * `NOT_FOUND`, and the same message whether the collection is absent or the id was never a
   * collection at all — a finance surface is platform-scoped, so there is no ownership to leak
   * here, but the uniform answer keeps this read indistinguishable from the driver-facing one.
   */
  codCollectionNotFound: (collectionId: string) =>
    new ApiException(ErrorCode.NOT_FOUND, 'COD collection not found.', { collectionId }),

  /**
   * A correction naming a remittance or reconciliation that is not this collection's (§1).
   *
   * Shared `CONFLICT`, no new code. It is not a validation error — both ids are well-formed and
   * both records may well exist — and it is not a not-found either, because the thing that is wrong
   * is the *relationship*. Attaching a correction to another collection's remittance would put a
   * statement about one driver's cash into another driver's trail, which is worse than refusing.
   */
  codCorrectionSubjectMismatch: (collectionId: string, details?: unknown) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'That remittance or reconciliation does not belong to this COD collection.',
      { collectionId, ...(typeof details === 'object' && details !== null ? details : {}) },
    ),

  /**
   * A correction naming a record that does not exist yet (§1's "where relevant").
   *
   * Distinct from the mismatch above: there is nothing to correct rather than the wrong thing. A
   * reconciliation-mistake correction on a collection nobody has reconciled is the common case, and
   * the honest answer is that the mistake being described has not happened.
   */
  codCorrectionSubjectMissing: (collectionId: string, subject: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `This COD collection has no ${subject} to correct.`,
      { collectionId, subject },
    ),

  /**
   * The same `idempotencyKey` was used for a materially different correction (§9).
   *
   * Reuses the already-shared `IDEMPOTENCY_CONFLICT` (409) exactly as `OrdersErrors` and
   * `PharmacyInventoryErrors` do for their replay keys, never silently returning the mismatched
   * record. Returning the first correction under a key the caller meant for a second one would
   * leave an operator believing a correction had been filed that was not.
   */
  codCorrectionIdempotencyConflict: (idempotencyKey: string) =>
    new ApiException(
      ErrorCode.IDEMPOTENCY_CONFLICT,
      'This idempotency key was already used for a different COD correction.',
      { idempotencyKey },
    ),

  /**
   * A record this call read a moment ago was changed by another request before it could write.
   *
   * Module 08's own copy of `OrdersErrors.concurrentModification` (ADR-002 — own copy per module,
   * never a cross-module import), carrying the same message `runWithDeliveryRetry` uses when it
   * exhausts its budget, so a client sees one consistent "retry" shape however the race was lost.
   * No new catalogue code: the shared `CONFLICT` already says exactly what is true.
   */
  concurrentModification: (details?: unknown) =>
    new ApiException(
      ErrorCode.CONFLICT,
      'This delivery record was changed concurrently by another request. Please retry.',
      details,
    ),

  /** A dispute id that is not this collection's, or does not exist. Same answer for both. */
  codDisputeNotFound: (disputeId: string) =>
    new ApiException(ErrorCode.NOT_FOUND, 'COD dispute not found.', { disputeId }),

  /**
   * An attempt to resolve a dispute that is not open (§5, §10).
   *
   * Shared `CONFLICT`. A conclusion an operator can overwrite is not a conclusion, so a second
   * resolution is refused rather than applied — and, because two operators closing the same dispute
   * at once is an ordinary thing to happen, the command answers a *matching* second resolution with
   * the committed one instead of this error. This is the mismatched case.
   */
  codDisputeNotOpen: (disputeId: string, status: string) =>
    new ApiException(
      ErrorCode.CONFLICT,
      `COD dispute ${disputeId} is not open (status ${status}).`,
      { disputeId, status },
    ),
};
