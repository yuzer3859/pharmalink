import {
  DriverJobsPageView,
  DriverOfferView,
} from '../../application/queries/list-driver-jobs.query';
import { DeliveryJobProps } from '../../domain/entities/delivery-job.entity';

/**
 * One job as the driver carrying it sees it in their list (§9.2).
 *
 * An explicit allow-list, like every other response in this module. What a driver needs from a list
 * is *where to go next and what the job involves* — the addresses, whether it is cold chain,
 * whether there is cash to collect and how much, and where in the lifecycle it sits. Everything
 * else is either served by the job's own detail read or belongs to somebody else entirely.
 *
 * Deliberately absent, each for its own reason:
 *
 *  - **`assignedDriverId`.** It is the caller, by construction. Echoing an internal profile id back
 *    to the handset that implied it adds an identifier to the wire and tells the driver nothing.
 *  - **The earning.** `DriverEarning` is a separate aggregate behind `delivery:earnings:own`. A job
 *    list is not a payslip, and a driver reading one has not asked to be told what they were paid.
 *  - **Proof-of-delivery artifacts.** Private, and served only through the authorized PoD read.
 *  - **COD remittance and reconciliation.** `codAmount` is here because the driver must know what
 *    to collect at the door; what happened to that cash afterwards is finance's record, behind
 *    finance's permissions, and a driver has no operational need for it.
 *  - **The customer and the manifest.** Names, phone numbers and the medicines themselves are
 *    Module 06's and Module 02's to serve, under their own authorization. A delivery job knows the
 *    items, and a list of every driver's manifests is a much larger thing to leak than an address.
 */
export interface DriverJobSummaryResponse {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  status: string;
  pickupAddress: string | null;
  dropoffAddress: string | null;
  isColdChain: boolean;
  isCod: boolean;
  /** ETB minor units (ADR-005), or `null` when this is not a cash delivery. */
  codAmount: number | null;
  distanceMeters: number | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/**
 * A live offer as the driver being asked sees it.
 *
 * `expiresAt` is the field the handset actually needs — it is what a countdown is drawn from, and
 * an offer without a visible deadline is one a driver cannot judge. `round` is included because a
 * driver seeing "round 4" learns something true about how long this job has been looking for
 * somebody; the drivers it was offered to first are **not** included, which would be telling one
 * driver about another's declined work.
 */
export interface DriverOfferResponse {
  offerId: string;
  round: number;
  offeredAt: string;
  expiresAt: string;
  job: DriverJobSummaryResponse;
}

export interface DriverJobsPageResponse {
  items: DriverJobSummaryResponse[];
  offers: DriverOfferResponse[];
  total: number;
  page: number;
  size: number;
}

export function toDriverOfferResponse(view: DriverOfferView): DriverOfferResponse {
  return {
    offerId: view.offer.id,
    round: view.offer.round,
    offeredAt: view.offer.offeredAt.toISOString(),
    expiresAt: view.offer.expiresAt.toISOString(),
    job: toDriverJobSummaryResponse(view.job),
  };
}

export function toDriverJobSummaryResponse(job: DeliveryJobProps): DriverJobSummaryResponse {
  return {
    jobId: job.id,
    orderId: job.orderId,
    fulfillmentId: job.fulfillmentId,
    status: job.status,
    pickupAddress: job.pickupAddress,
    dropoffAddress: job.dropoffAddress,
    isColdChain: job.isColdChain,
    isCod: job.isCod,
    codAmount: job.codAmount,
    distanceMeters: job.distanceMeters,
    pickedUpAt: job.pickedUpAt ? job.pickedUpAt.toISOString() : null,
    deliveredAt: job.deliveredAt ? job.deliveredAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
  };
}

export function toDriverJobsPageResponse(view: DriverJobsPageView): DriverJobsPageResponse {
  return {
    items: view.items.map(toDriverJobSummaryResponse),
    offers: view.offers.map(toDriverOfferResponse),
    total: view.total,
    page: view.page,
    size: view.size,
  };
}
