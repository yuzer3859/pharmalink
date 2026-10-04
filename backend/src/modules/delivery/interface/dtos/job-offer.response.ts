import { AcceptJobOfferResult } from '../../application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobResult } from '../../application/commands/advance-delivery-job.command';
import { DeclineJobOfferResult } from '../../application/commands/decline-job-offer.command';
import { DeliveryJobStatusView } from '../../application/queries/get-delivery-job-status.query';
import { DeliveryItemSummary } from '../../domain/entities/delivery-job.entity';

/**
 * The job as the assigned driver sees it after accepting (§9.2).
 *
 * An explicit allow-list, mapped field by field, the same discipline `toSettlementResponse`
 * applies — a column added to `delivery_jobs` later must not silently become part of a
 * driver-facing API.
 *
 * ## What a driver is given, and what they are not
 *
 * They get where to collect, where to deliver, what to check at handover, whether it needs a cold
 * box, and what cash to collect. They do **not** get the customer's identity, the order's
 * financial breakdown, any prescription reference, or any product price — `customerUserId`,
 * `orderId`'s totals and every health-adjacent field are absent here because delivery is the least
 * privileged context this data passes through, and the job's own `items` snapshot was built thin
 * for the same reason.
 *
 * `codAmount` is the one money figure, and it is present because the driver must know what to ask
 * for: it is the number a COD dispute is argued over.
 */
export interface DriverJobResponse {
  jobId: string;
  orderId: string;
  status: string;
  pickup: { lat: number; lng: number } | null;
  pickupAddress: string | null;
  dropoff: { lat: number; lng: number } | null;
  dropoffAddress: string | null;
  items: DeliveryItemSummary[];
  isColdChain: boolean;
  isCod: boolean;
  /** Integer minor units of ETB (ADR-005), or `null` when the order was paid online. */
  codAmount: number | null;
}

export interface AcceptJobOfferResponse {
  job: DriverJobResponse;
  offerId: string;
  acceptedAt: string | null;
}

export interface DeclineJobOfferResponse {
  offerId: string;
  status: string;
  declinedAt: string | null;
  reason: string | null;
}

export function toAcceptJobOfferResponse(
  result: AcceptJobOfferResult,
): AcceptJobOfferResponse {
  const job = result.job;
  return {
    job: {
      jobId: job.id,
      orderId: job.orderId,
      status: job.status,
      pickup: job.pickupPoint ? { lat: job.pickupPoint.lat, lng: job.pickupPoint.lng } : null,
      pickupAddress: job.pickupAddress,
      dropoff: job.dropoffPoint
        ? { lat: job.dropoffPoint.lat, lng: job.dropoffPoint.lng }
        : null,
      dropoffAddress: job.dropoffAddress,
      items: job.items.map((item) => ({ ...item })),
      isColdChain: job.isColdChain,
      isCod: job.isCod,
      codAmount: job.codAmount,
    },
    offerId: result.offer.id,
    acceptedAt: result.offer.respondedAt?.toISOString() ?? null,
  };
}

/**
 * The decline's own outcome only.
 *
 * It deliberately does **not** report what the follow-on re-dispatch did — who the job went to
 * next, or that nobody was available. That is another driver's business and the platform's, and a
 * driver who declined a job has no reason to learn who ended up with it. The command returns it
 * for logging and for tests; the wire format drops it.
 */
export function toDeclineJobOfferResponse(
  result: DeclineJobOfferResult,
): DeclineJobOfferResponse {
  return {
    offerId: result.offer.id,
    status: result.offer.status,
    declinedAt: result.offer.respondedAt?.toISOString() ?? null,
    reason: result.offer.reason,
  };
}

/**
 * What a driver gets back from a status post (§9.2).
 *
 * `changed: false` is the honest answer to a duplicate — the request succeeded, and nothing
 * happened because the job was already there. A client that retried on a timeout can tell that
 * from a first delivery without having to compare timestamps, and §12's "duplicate `/picked-up`
 * returns current state, not error" is satisfied without pretending a second transition occurred.
 */
export interface DeliveryStatusResponse {
  jobId: string;
  status: string;
  changed: boolean;
  pickedUpAt: string | null;
  deliveredAt: string | null;
}

export function toDeliveryStatusResponse(
  result: AdvanceDeliveryJobResult,
): DeliveryStatusResponse {
  return {
    jobId: result.job.id,
    status: result.job.status,
    changed: result.changed,
    pickedUpAt: result.job.pickedUpAt?.toISOString() ?? null,
    deliveredAt: result.job.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * A job's status and how it got there (§9.4's REST fallback), as the assigned driver sees it.
 *
 * An explicit allow-list like every other response in this module. It carries the timeline and
 * the transition trail and **no location**: §9.4 pairs the status read with a last-known position,
 * and that belongs to the tracking work along with the question of who is allowed to see it.
 */
export interface DeliveryJobStatusResponse {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  status: string;
  timeline: Record<string, string | null>;
  history: { from: string | null; to: string; at: string; actorType: string; reason: string | null }[];
}

export function toDeliveryJobStatusResponse(
  view: DeliveryJobStatusView,
): DeliveryJobStatusResponse {
  const timeline: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(view.timeline)) {
    timeline[key] = value ? value.toISOString() : null;
  }
  return {
    jobId: view.jobId,
    orderId: view.orderId,
    fulfillmentId: view.fulfillmentId,
    status: view.status,
    timeline,
    history: view.history.map((entry) => ({
      from: entry.from,
      to: entry.to,
      at: entry.at.toISOString(),
      actorType: entry.actorType,
      reason: entry.reason,
    })),
  };
}
