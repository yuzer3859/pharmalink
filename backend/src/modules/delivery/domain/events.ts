import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Delivery domain event types (`architecture/module-08-delivery-tracking.md` §10's `events/`),
 * matching `00-domain-event-catalog.md`'s Module 08 row **restricted to the subset actually
 * reachable today** — the same discipline Module 06's own event file applies. `EarningAccrued`
 * joined the list with the driver-earnings work, which is the first with a trigger for it, and
 * `CodCollected` with the COD work, which is the first to record a collection. Every event the
 * catalogue lists for Module 08 now has a writer.
 *
 * Written to the outbox in the same transaction as the state change that produced it (ADR-010).
 *
 * ## Naming
 *
 * Every type is namespaced under `delivery.`, which is what keeps `OrderDelivered` *(delivery)*
 * distinct from the `OrderDelivered` Module 06 will one day publish about its own aggregate. The
 * catalogue disambiguates the two with a parenthetical; the dotted names do it structurally.
 */
export const DeliveryEventType = {
  JobCreated: 'delivery.job.created',
  JobOffered: 'delivery.job.offered',
  JobAssigned: 'delivery.job.assigned',
  // The status workflow's four (§3.3 F-STS-03, BR-DEL-07). Catalogued as `OrderPickedUp`,
  // `EnRoute`, `OrderDelivered` (delivery) and `DeliveryFailed`.
  OrderPickedUp: 'delivery.order.picked_up',
  EnRoute: 'delivery.order.en_route',
  OrderDelivered: 'delivery.order.delivered',
  DeliveryFailed: 'delivery.failed',
  // The earnings work's one event (§3.5 F-ERN-02, catalogued as `EarningAccrued` with consumer 07
  // for settlement). Namespaced under `delivery.` like the rest: what a *driver* earned for a
  // delivery is Module 08's fact, distinct from whatever Module 07 later publishes about paying it.
  EarningAccrued: 'delivery.earning.accrued',
  // The COD work's one event (§3.5 F-COD-01, catalogued as `CodCollected` with consumer 07 for
  // reconciliation). A statement of fact about cash a driver says they took — never an instruction
  // to move money, which is Module 07's to decide.
  CodCollected: 'delivery.cod.collected',
  // The remittance work's two. Neither is in `00-domain-event-catalog.md`, whose Module 08 row
  // stops at `CodCollected` — and that gap is exactly the one §15 asks to close: a consumer told
  // only that a driver *declared* taking cash cannot tell when the platform actually received it,
  // which is the moment a financial layer cares about. The catalogue is updated alongside this
  // file, as the dispatch work did for `JobOffered`.
  //
  // Both earn their place by being a different party's assertion rather than a state's shadow
  // (§14's "do not add an event merely because a state exists"): `CodRemitted` is PharmaLink
  // taking custody of the money, `CodReconciled` is PharmaLink's finding about it. A future
  // Module 07 posting is driven by one or the other, never by the driver's declaration alone.
  CodRemitted: 'delivery.cod.remitted',
  CodReconciled: 'delivery.cod.reconciled',
  // The corrections work's **one** event, and the count is the decision.
  //
  // A correction can restate an amount that a future Module 07 posting was, or will be, derived
  // from — so a consumer that acted on `CodReconciled` has a real reason to learn that the figures
  // behind it were wrong. That is a downstream need, and this is the module's only handoff.
  //
  // **No dispute event is emitted**, neither on opening nor on resolution. A dispute is PharmaLink's
  // internal follow-up state: nothing outside Module 08 acts on it, Module 07 must post nothing on
  // it (§7), and the event catalogue has no COD notification for Module 13 to send. Emitting one
  // would be adding an event because a record exists — which is exactly what §8 rules out.
  //
  // **Work 14 re-checked whether Module 07 has become a real consumer. It has not.** No module
  // outside Module 08 subscribes to any `delivery.*` event anywhere in the repository — Module 07
  // has no inbound COD port, no handler and no ledger posting keyed to a delivery event. So this
  // stays a published fact with no consumer yet, which is the correct shape for a boundary: the
  // event is durable in the outbox and a future Module 07 contract can read it without Module 08
  // changing. Nothing was invented to meet it halfway — no inbound port, no COD ledger entry, no
  // settlement, and nothing anywhere marked financially settled.
  CodCorrectionRecorded: 'delivery.cod.correction_recorded',
} as const;

/**
 * `JobCreated` (catalogued as `jobId, orderId, driverId`, consumers 06 and 13).
 *
 * `driverId` is deliberately absent rather than `null`: a job is created unassigned by definition
 * (§3.3's lifecycle starts at `CREATED`), so the field the catalogue lists belongs to
 * `JobAssigned`, which is the event that actually carries one. `fulfillmentId` is included
 * because it is the job's natural key — a consumer resolving "which fulfillment is this about?"
 * should not have to query for it.
 */
export interface JobCreatedPayload {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  pharmacyId: string;
  branchId: string;
  isColdChain: boolean;
  isCod: boolean;
}

export function jobCreatedEvent(payload: JobCreatedPayload): DomainEvent<JobCreatedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.JobCreated,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/**
 * `JobOffered` — a job has been offered to a driver, who has until `expiresAt` to answer.
 *
 * **This event is not in `00-domain-event-catalog.md`, and is added by the dispatch work rather
 * than reused.** The catalogue's Module 08 row pairs `JobCreated / JobAssigned` and has no
 * offer-stage event at all, which leaves FR-NOT-07 — "drivers are notified of new job
 * assignments" — without a trigger: by the time `JobAssigned` fires the driver has already
 * accepted, so a notification driven by it would tell them about a job they are already carrying.
 * §11.1's flow is explicit that the notification happens at the offer ("DispatchJob →
 * INotificationPort (FCM) + IRealtimePort (WS) notify driver (FR-NOT-07)"), and this is the event
 * that carries it. The catalogue row is updated alongside this file.
 *
 * `expiresAt` travels in the payload because a notification without the deadline is a notification
 * the driver cannot act on sensibly — a countdown is the whole user experience of an offer.
 *
 * `driverId` is a `driver_profiles.id`. A consumer that needs to reach the human — Module 13 —
 * resolves it through Module 08 rather than receiving a Module 01 user id from a context that
 * does not own one.
 */
export interface JobOfferedPayload {
  jobId: string;
  offerId: string;
  orderId: string;
  driverId: string;
  round: number;
  expiresAt: string;
}

export function jobOfferedEvent(payload: JobOfferedPayload): DomainEvent<JobOfferedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.JobOffered,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/**
 * `JobAssigned` (catalogued as `jobId, orderId, driverId`, consumers 06 and 13) — a driver
 * accepted, and the job is theirs.
 *
 * The catalogue's own shape, carried verbatim, plus `offerId` so a consumer can reach the offer
 * that produced the assignment without querying for it. Module 06 advances its order state from
 * this; Module 13 notifies the customer.
 *
 * Emitted on **reassignment as well as first assignment** — the second driver's acceptance is an
 * assignment in exactly the same sense, and a consumer that only heard about the first would have
 * the wrong driver on a customer's screen for the rest of the delivery.
 */
export interface JobAssignedPayload {
  jobId: string;
  offerId: string;
  orderId: string;
  /** `driver_profiles.id` — see `JobOfferedPayload.driverId`. */
  driverId: string;
}

export function jobAssignedEvent(payload: JobAssignedPayload): DomainEvent<JobAssignedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.JobAssigned,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/**
 * The shape every status event shares (§3.3 F-STS-03's "status updates emitted to Orders").
 *
 * ## Identifiers, not an aggregate
 *
 * Four ids, the resulting status, and nothing else. A consumer that needs the manifest, the
 * addresses or the fee reads them from the module that owns them; copying the job into its own
 * events would make every consumer a second home for delivery data and would turn any change to
 * `DeliveryJob` into a breaking change for Modules 06, 13 and 15 at once.
 *
 * `fulfillmentId` is here even though the catalogue's rows list only `jobId, orderId`. Module 06's
 * order can split across pharmacies, so "this order is dispatched" is ambiguous where "this
 * fulfillment is dispatched" is not — and `fulfillmentId` is the job's own natural key, so
 * including it costs nothing and saves every consumer a lookup.
 *
 * `driverId` is a `driver_profiles.id`. A consumer that needs the human resolves it through
 * Module 08 rather than receiving a Module 01 user id from a context that does not own one.
 *
 * **No location and no proof of delivery.** The catalogue lists `podRef` on `OrderDelivered`, and
 * it is deliberately absent until proof of delivery exists: a field that can only ever be `null`
 * advertises a capability the platform does not have, and a consumer written against it would be
 * written against a guess. `occurredAt` is the envelope's, already on every `DomainEvent`.
 */
export interface DeliveryStatusPayload {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` of the driver carrying the job. */
  driverId: string;
  /** The job's status *after* the transition. */
  status: string;
}

/**
 * `OrderPickedUp` (catalogued as `jobId, orderId`, consumer 06 → `DISPATCHED`).
 *
 * The moment the medicines leave the pharmacy. This is the event Module 06 advances an order on,
 * and the reason the pickup boundary is enforced so firmly on this side: once it has fired, the
 * platform has told another context that goods are in transit.
 */
export function orderPickedUpEvent(
  payload: DeliveryStatusPayload,
): DomainEvent<DeliveryStatusPayload> {
  return createDomainEvent({
    type: DeliveryEventType.OrderPickedUp,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/** `EnRoute` (catalogued as `jobId`, consumers 06 and tracking). */
export function enRouteEvent(
  payload: DeliveryStatusPayload,
): DomainEvent<DeliveryStatusPayload> {
  return createDomainEvent({
    type: DeliveryEventType.EnRoute,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/**
 * `OrderDelivered` *(delivery)* (catalogued as `jobId, orderId, podRef`, consumers 06 → `DELIVERED`,
 * 13, 15).
 *
 * Emitted at `DELIVERED` — the driver's assertion that the handover happened — and **not** at
 * `COMPLETED`. The two are different facts: the customer has their medicine at the first, and the
 * platform has squared its books at the second. Module 06, a notification and a review prompt all
 * key off the first.
 */
export function orderDeliveredEvent(
  payload: DeliveryStatusPayload,
): DomainEvent<DeliveryStatusPayload> {
  return createDomainEvent({
    type: DeliveryEventType.OrderDelivered,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/**
 * `DeliveryFailed` (catalogued as `jobId, reason`, consumers 06 for refund/return, 13).
 *
 * **The boundary, and the whole of Module 08's part in it.** §3.3 F-STS-05's "retry/return policy
 * → Orders/refund hook" is Module 06's and Module 07's to decide: this module records that the
 * delivery did not happen and says why, and does not cancel an order, does not initiate a refund
 * and does not decide whether the medicines go back to the pharmacy. Delivery knowing what a
 * failed delivery costs would be Delivery owning money.
 */
export interface DeliveryFailedPayload extends DeliveryStatusPayload {
  reason: string;
}

export function deliveryFailedEvent(
  payload: DeliveryFailedPayload,
): DomainEvent<DeliveryFailedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.DeliveryFailed,
    aggregateType: 'DeliveryJob',
    aggregateId: payload.jobId,
    payload,
  });
}

/**
 * `EarningAccrued` (catalogued as `driverId, jobId, amount`, consumer **07 (settlement)**).
 *
 * ## The whole of Module 08's handoff to the financial layer
 *
 * There is no port into Module 07, no synchronous call and no shared table — this event, written
 * to the outbox in the same transaction as the earning row (ADR-010), *is* the boundary (§1's
 * "does not own money ... it reports earnings and COD collection for settlement"). Module 08
 * creates no ledger entry, moves no wallet balance, opens no settlement and calls no provider.
 *
 * It carries more than the catalogue's three fields, and each addition earns its place by being
 * something a settlement run would otherwise have to come back into Module 08 to ask for:
 *
 *  - **`earningId`** — the thing being settled, and the idempotency key a consumer needs, because
 *    at-least-once delivery means this event will sometimes arrive twice.
 *  - **`orderId` / `fulfillmentId`** — what a driver's payment reconciles *against*. A statement
 *    line that named only a delivery job would make Module 07 join into Module 08's tables.
 *  - **`currency`** — never assumed. An amount without one is not money.
 *  - **`calculationVersion`** — which earning agreement produced the figure, so a disputed payment
 *    is answered by naming the rate card rather than by re-deriving it from today's configuration.
 *
 * `occurredAt` is on the envelope, as it is for every event in this catalogue.
 *
 * ## What is deliberately absent
 *
 * **Nothing about how the driver is paid.** No bank account, no wallet id, no Telebirr handle, no
 * payout reference, no schedule. Module 08 does not know any of it and must not appear to: payout
 * mechanics are Module 07's, and an event that carried a bank detail would put a driver's banking
 * information into every consumer's log for no reason.
 *
 * No Module 01 identity either — `driverId` is a `driver_profiles.id`, and a consumer that needs a
 * name asks the module that owns names.
 */
export interface EarningAccruedPayload {
  earningId: string;
  /** `driver_profiles.id` — the operational driver, not a Module 01 `users.id`. */
  driverId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** Minor units (ADR-005). What is owed, after rounding and clamping. */
  amount: number;
  currency: string;
  /** The earning agreement the amount was computed under. */
  calculationVersion: string;
}

export function earningAccruedEvent(
  payload: EarningAccruedPayload,
): DomainEvent<EarningAccruedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.EarningAccrued,
    // The earning, not the job: this event is about the ledger row, and a consumer replaying the
    // stream for one earning should find it under its own aggregate id.
    aggregateType: 'DriverEarning',
    aggregateId: payload.earningId,
    payload,
  });
}

/**
 * `CodCollected` (catalogued as `jobId, amount`, consumer **07 (reconcile)**).
 *
 * ## The whole of Module 08's COD handoff
 *
 * There is no port into Module 07, no synchronous call and no shared table — this event, written to
 * the outbox in the same transaction as the collection row (ADR-010), *is* the boundary (§1's
 * "does not own money ... it reports earnings and COD collection for settlement"). Module 08
 * creates no ledger entry, marks no `Payment` captured, moves no wallet balance and opens no
 * settlement.
 *
 * It carries more than the catalogue's two fields, and each addition is something a reconciliation
 * would otherwise have to come back into Module 08 to ask for:
 *
 *  - **`collectionId`** — the thing being reconciled, and the idempotency key a consumer needs,
 *    because at-least-once delivery means this event will sometimes arrive twice.
 *  - **`expectedAmount` beside `collectedAmount`** — the single most important pair on the wire. A
 *    consumer given only what was collected cannot tell a correct collection from a short one, and
 *    a COD reconciliation exists precisely to find the short ones.
 *  - **`orderId` / `fulfillmentId`** — what the cash reconciles *against*.
 *  - **`driverId`** — which channel is holding it. A `driver_profiles.id`, never a Module 01 user.
 *  - **`method` and `providerReference`** — cash or electronic, and the opaque transaction number
 *    a human can quote. Generic by construction: no provider name, no callback body, no signature.
 *  - **`currency`** — never assumed. An amount without one is not money.
 *
 * `occurredAt` is on the envelope, as it is for every event in this catalogue.
 *
 * ## What is deliberately absent
 *
 * No card number, no CVV, no provider secret, no callback payload, no customer token, no media, no
 * note denominations, and nothing about the *customer* at all. A consumer that needs any of it is
 * asking the wrong module.
 *
 * And no instruction. The event says a driver declared they took this much cash; it does not say
 * the platform has the money, does not say the pharmacy should be paid, and carries no settlement
 * or payout field through which it could imply either.
 */
export interface CodCollectedPayload {
  collectionId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` — the collection channel, not a Module 01 `users.id`. */
  driverId: string;
  /** Minor units (ADR-005): what the order came to, frozen on the job. */
  expectedAmount: number;
  /** Minor units: what the driver declared they received. */
  collectedAmount: number;
  currency: string;
  /** `CASH` or `ELECTRONIC`. Never a provider name. */
  method: string;
  /** An opaque transaction reference, or `null`. Never a provider payload. */
  providerReference: string | null;
  /** ISO-8601 — when the driver says the money changed hands. */
  collectedAt: string;
}

export function codCollectedEvent(
  payload: CodCollectedPayload,
): DomainEvent<CodCollectedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.CodCollected,
    // The collection, not the job: this event is about the money record, and a consumer replaying
    // the stream for one collection should find it under its own aggregate id.
    aggregateType: 'CodCollection',
    aggregateId: payload.collectionId,
    payload,
  });
}

/**
 * `CodRemitted` — the delivery channel has handed the collected money to PharmaLink.
 *
 * ## What it says, and the three things it does not
 *
 * It says an authorized PharmaLink operator confirmed receiving this much money, under this
 * handle, against this collection. It does **not** say the amounts were checked (that is
 * `CodReconciled`), does not say the pharmacy has been paid, and carries no instruction to post
 * anything — §15 keeps every ledger entry, payable and settlement on Module 07's side of the line,
 * and this module writes none of them.
 *
 * ## Why all three amounts ride together
 *
 * `expectedAmount`, `collectedAmount` and `remittedAmount` are on the wire at once because the
 * question a COD process exists to answer is not "how much" but "how much against how much against
 * how much". A consumer handed only the remitted figure cannot tell a clean handover from a channel
 * that collected 24,500 and handed over 20,000 — which is the single failure the remittance step
 * was added to surface. Subtracting is the consumer's; being *able* to subtract is this payload's.
 *
 * `reference` is the generic PharmaLink-side handle, shared by every collection in the same
 * handover, so a consumer can reconstruct a batch without this module having invented one.
 *
 * ## What is deliberately absent
 *
 * No bank name, no account number, no mobile-money handle, no provider payload, no signature, no
 * token, no cash-office address, and nothing about the customer. `confirmedByUserId` is a Module 01
 * user id and nothing more — no name, no phone, no role — because a consumer that needs to know who
 * an operator *is* asks the module that owns identity.
 */
export interface CodRemittedPayload {
  remittanceId: string;
  collectionId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` — the collection channel, not a Module 01 `users.id`. */
  driverId: string;
  /** Minor units (ADR-005): what the order came to, frozen on the job. */
  expectedAmount: number;
  /** Minor units: what the driver declared receiving from the customer. */
  collectedAmount: number;
  /** Minor units: what actually reached PharmaLink. */
  remittedAmount: number;
  currency: string;
  /** `CASH` or `ELECTRONIC`. Never a provider name. */
  method: string;
  /** The collection's opaque transaction reference, or `null`. Never a provider payload. */
  providerReference: string | null;
  /** The generic PharmaLink-side handle for this handover. Shared across a batch. */
  reference: string;
  /** Module 01 `users.id` of the operator who confirmed it — the separation of duties, on the wire. */
  confirmedByUserId: string;
  /** ISO-8601 — when the money reached PharmaLink. */
  remittedAt: string;
}

export function codRemittedEvent(payload: CodRemittedPayload): DomainEvent<CodRemittedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.CodRemitted,
    // The collection, as `CodCollected` is, so a consumer replaying one collection's stream reads
    // its three legs in order under one aggregate id rather than having to join three of them.
    aggregateType: 'CodCollection',
    aggregateId: payload.collectionId,
    payload,
  });
}

/**
 * `CodReconciled` — PharmaLink has checked the remittance against the collection and recorded what
 * it found.
 *
 * ## The event a financial layer is actually waiting for
 *
 * Of the three COD events this module emits, this is the one that carries a *verified* statement
 * about money the platform holds. `CodCollected` is a driver's declaration and `CodRemitted` is a
 * receipt; this is the check. §16's "reconciled cash → financial ledger → pharmacy
 * payable/settlement" starts here — on Module 07's side of the line, when Module 07 has a contract
 * for it. Module 08 posts nothing.
 *
 * ## `outcome` is the payload's point
 *
 * A consumer must be able to tell a clean reconciliation from one that found a difference **without
 * re-deriving it**, because the two lead to different financial treatment and the arithmetic must
 * not be done twice in two modules with two chances to differ. `ACCEPTED` means every amount agreed;
 * `DISCREPANCY` means at least one did not, and the three amounts travel alongside so a consumer can
 * see which.
 *
 * `DISCREPANCY` is **not** an instruction. It does not say to recover from the driver, to absorb the
 * loss or to withhold a settlement — nobody has decided any of that (the design's Open Question 5),
 * and an event that implied one would be this module quietly setting a commercial policy.
 *
 * ## What is deliberately absent
 *
 * The same list as `CodRemitted`: no provider payload, no secret, no token, no banking detail, no
 * media, and nothing about the customer.
 */
export interface CodReconciledPayload {
  reconciliationId: string;
  collectionId: string;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` — the collection channel, not a Module 01 `users.id`. */
  driverId: string;
  /** Minor units (ADR-005): due, declared, and received — the three figures being reconciled. */
  expectedAmount: number;
  collectedAmount: number;
  remittedAmount: number;
  currency: string;
  /** `CASH` or `ELECTRONIC`. Never a provider name. */
  method: string;
  /** The collection's opaque transaction reference, or `null`. */
  providerReference: string | null;
  /** The handover's generic handle. */
  remittanceReference: string;
  /** The reconciliation run's own handle, where the operator gave one. */
  reconciliationReference: string | null;
  /** `ACCEPTED` or `DISCREPANCY` — the platform's finding, never a caller's claim. */
  outcome: string;
  /** Module 01 `users.id` of the operator who reconciled it. */
  reconciledByUserId: string;
  /** ISO-8601 — when the finding was recorded. */
  reconciledAt: string;
}

export function codReconciledEvent(
  payload: CodReconciledPayload,
): DomainEvent<CodReconciledPayload> {
  return createDomainEvent({
    type: DeliveryEventType.CodReconciled,
    aggregateType: 'CodCollection',
    aggregateId: payload.collectionId,
    payload,
  });
}

/**
 * `CodCorrectionRecorded` — an authorized operator has recorded that a COD record was wrong.
 *
 * ## Why this one event exists when the dispute events do not
 *
 * A correction can restate an amount that a Module 07 posting was derived from. A consumer that
 * acted on `CodReconciled` — or that will, once Module 07 has a COD contract — needs to learn that
 * the figures behind it were mistaken, and this module's only handoff is its events. That is a real
 * downstream need rather than a record wanting an announcement.
 *
 * Opening and resolving a dispute have no such consumer, so they emit nothing.
 *
 * ## It is a statement, not an instruction
 *
 * It says what the record should have said. It does **not** say to post an adjustment, to recover
 * money from a driver, to write a shortfall off, or to release a settlement — and it carries no
 * field through which any of those could be implied. Whether a corrected figure changes what the
 * platform owes anybody is a decision for whoever owns the ledger, taken with the commercial rules
 * the design's Open Question 5 still leaves open.
 *
 * **The original figures travel with it**, which is the payload's main point: a consumer must be
 * able to see what was recorded *and* what it should have been, because the correction is an
 * addition to the history rather than a replacement for it. A payload carrying only the corrected
 * value would be indistinguishable from a rewrite.
 *
 * ## What is deliberately absent
 *
 * No card data, token, provider secret, callback body or media. Nothing about the customer. No
 * driver identity beyond `driverId`, a `driver_profiles.id`. No balance, payable or payout field.
 */
export interface CodCorrectionRecordedPayload {
  correctionId: string;
  collectionId: string;
  /** The record the correction is about, when it is not the collection itself. */
  remittanceId: string | null;
  reconciliationId: string | null;
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  /** `driver_profiles.id` — the collection channel, not a Module 01 `users.id`. */
  driverId: string;
  /** One of the four `CodCorrectionType` values. Never a write-off or a recovery. */
  type: string;
  /** Minor units (ADR-005). Both null for a non-monetary correction. */
  originalAmount: number | null;
  correctedAmount: number | null;
  /** Both null for a non-reference correction. Opaque handles, never provider payloads. */
  originalReference: string | null;
  correctedReference: string | null;
  currency: string;
  /** Why the operator says the record was wrong. */
  reason: string;
  /** Module 01 `users.id` of the operator who recorded it — never the driver. */
  createdByUserId: string;
  /** ISO-8601. */
  createdAt: string;
}

export function codCorrectionRecordedEvent(
  payload: CodCorrectionRecordedPayload,
): DomainEvent<CodCorrectionRecordedPayload> {
  return createDomainEvent({
    type: DeliveryEventType.CodCorrectionRecorded,
    // The collection, as the other two COD events are, so one collection's whole history —
    // collected, remitted, reconciled, corrected — replays in order under one aggregate id.
    aggregateType: 'CodCollection',
    aggregateId: payload.collectionId,
    payload,
  });
}
