import { Inject, Injectable } from '@nestjs/common';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import { DomainEvent } from '../../../../shared/events/domain-event';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import {
  IPrescriptionReviewRoutingPort,
  PRESCRIPTION_REVIEW_ROUTING_PORT,
} from '../../../prescription-matching/application/ports/inbound/prescription-review-routing.port';
import { OrdersErrors } from '../../domain/errors';
import { rxRequestEvents } from '../../domain/rx-request-events';
import {
  IRxRequestRepository,
  RX_REQUEST_REPOSITORY,
  RxRequestOfferSnapshot,
  RxRequestSnapshot,
} from '../../domain/repositories/rx-request.repository';
import { RX_REQUEST_CLOSED_REASON, RxRequestPolicy } from '../../domain/services/rx-request-policy';
import { ADDRESS_PORT, IAddressPort } from '../ports/outbound/address.port';
import { IRxRequestPharmaciesPort, RX_REQUEST_PHARMACIES_PORT } from '../ports/outbound/rx-request-pharmacies.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithOrderRetry } from '../support/order-retry';

export interface CreateRxRequestInput {
  customerUserId: string;
  prescriptionId: string;
  addressId: string;
  /** The date written on the prescription, as the customer reads it. */
  prescriptionIssueDate: Date;
  note?: string | null;
}

export interface RxRequestActorInput {
  requestId: string;
  actorUserId: string;
}

export const RxRequestErrors = {
  unavailable: (message = 'This request is no longer available: another pharmacy accepted it, or it has ended.') =>
    new ApiException(ErrorCode.RX_REQUEST_UNAVAILABLE, message),
  tooOld: (message: string) => new ApiException(ErrorCode.PRESCRIPTION_TOO_OLD, message),
  notFound: () => OrdersErrors.notFound('Prescription request not found.'),
};

/** Requests that still involve a pharmacy and can still be ended by the customer. */
const LIVE_STATUSES = ['OPEN', 'CLAIMED'] as const;

/**
 * Work 134 (owner decision 2026-11-17): a prescription request, ride-hailing style.
 *
 * - **Send** (`create`): the customer's uploaded prescription and delivery address are offered to
 *   every eligible pharmacy near it (`IRxRequestPharmaciesPort.findEligible`). The pharmacies'
 *   owners and pharmacists are told at once. With none eligible the request ends `NO_PHARMACY`.
 * - **Accept**: the first pharmacist to accept owns it. The claim is one conditional UPDATE on the
 *   request (`OPEN -> CLAIMED`), so of two pharmacists accepting together exactly one wins; the
 *   other is told it is taken (`RX_REQUEST_UNAVAILABLE`). The other pharmacies' offers become
 *   `TAKEN` and they are told it is no longer available. The customer is told who accepted.
 * - **Decline**: a pharmacy that cannot fill it says so; once every offer is declined the request
 *   ends `NO_PHARMACY` and the customer is told.
 * - **Release** / **lapse**: the accepting pharmacy lets it go, or does not quote within
 *   `rxRequests.claimMinutes` (the sweeper). The request is offered to the others again — their
 *   `TAKEN` offers reopen, the offer window is extended to a full window from now — and the
 *   customer and those pharmacies are told. That pharmacy cannot take it again.
 * - **Expire**: nobody accepted within `rxRequests.offerMinutes` (the sweeper).
 * - **Cancel**: the customer withdraws it while no quote is agreed.
 *
 * Every transition is a compare-and-set in a Serializable transaction with its audit and outbox
 * rows, so a retry or a race never applies one twice.
 */
@Injectable()
export class RxRequestCommands {
  constructor(
    @Inject(RX_REQUEST_REPOSITORY) private readonly requests: IRxRequestRepository,
    @Inject(RX_REQUEST_PHARMACIES_PORT) private readonly pharmacies: IRxRequestPharmaciesPort,
    @Inject(ADDRESS_PORT) private readonly addresses: IAddressPort,
    @Inject(PRESCRIPTION_REVIEW_ROUTING_PORT) private readonly rxReview: IPrescriptionReviewRoutingPort,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async create(input: CreateRxRequestInput, now = new Date()): Promise<RxRequestSnapshot> {
    const tooOld = RxRequestPolicy.issueDateProblem(input.prescriptionIssueDate, now, RxRequestPolicy.maxAgeDays(this.config));
    if (tooOld) throw RxRequestErrors.tooOld(tooOld);

    const address = await this.addresses.getAddress(input.addressId, input.customerUserId);
    if (!address) throw OrdersErrors.notFound('Address not found.');
    if (address.lat == null || address.lng == null) {
      throw OrdersErrors.validation('The delivery address needs its map location, so nearby pharmacies can be found.', { field: 'addressId' });
    }
    // Owned by the customer, uploaded, and on no order yet; and on no other request.
    await this.rxReview.assertAttachable({ customerUserId: input.customerUserId, prescriptionId: input.prescriptionId });
    if (await this.requests.findByPrescriptionId(input.prescriptionId)) {
      throw OrdersErrors.validation('This prescription was already sent. Upload it again to send a new request.', { field: 'prescriptionId' });
    }

    const point = { lat: address.lat, lng: address.lng };
    const eligible = await this.pharmacies.findEligible(point, RxRequestPolicy.radiusMeters(this.config), now);
    const staff = await this.pharmacies.staffUserIds(eligible.map((e) => e.pharmacyId));
    const none = eligible.length === 0;

    return runWithOrderRetry(this.uow, async (tx) => {
      const created = await this.requests.create(
        {
          customerUserId: input.customerUserId,
          prescriptionId: input.prescriptionId,
          addressId: input.addressId,
          deliveryLat: point.lat,
          deliveryLng: point.lng,
          prescriptionIssueDate: input.prescriptionIssueDate,
          note: input.note?.trim() || null,
          status: none ? 'NO_PHARMACY' : 'OPEN',
          expiresAt: RxRequestPolicy.addMinutes(now, RxRequestPolicy.offerMinutes(this.config)),
          closedReason: none ? RX_REQUEST_CLOSED_REASON.NO_PHARMACY : null,
          closedAt: none ? now : null,
        },
        eligible.map((e) => ({ pharmacyId: e.pharmacyId, branchId: e.branchId, distanceMeters: e.distanceMeters })),
        tx,
      );
      await this.audit.record(
        { actorUserId: input.customerUserId, action: 'RX_REQUEST_SENT', resourceType: 'RxRequest', resourceId: created.id, context: { offeredTo: eligible.length } },
        tx,
      );
      if (none) {
        await this.outbox.write(rxRequestEvents.ended({ requestId: created.id, customerUserId: input.customerUserId, status: 'NO_PHARMACY' }), tx as never);
      } else {
        await this.outbox.write(rxRequestEvents.offered({ requestId: created.id, recipientUserIds: recipients(staff, eligible.map((e) => e.pharmacyId)) }), tx as never);
      }
      return created;
    });
  }

  async accept(input: RxRequestActorInput, now = new Date()): Promise<RxRequestSnapshot> {
    const { request, offer } = await this.callerOffer(input);
    if (offer.status !== 'OPEN' || request.status !== 'OPEN' || request.expiresAt <= now) throw RxRequestErrors.unavailable();

    // Who to tell, read before the transaction; the events are written inside it.
    const [names, staff] = await Promise.all([this.pharmacies.displayNames([offer.pharmacyId]), this.staffOf(request)]);

    await runWithOrderRetry(this.uow, async (tx) => {
      const won = await this.requests.claim(
        {
          requestId: request.id,
          pharmacyId: offer.pharmacyId,
          branchId: offer.branchId,
          userId: input.actorUserId,
          now,
          claimExpiresAt: RxRequestPolicy.addMinutes(now, RxRequestPolicy.claimMinutes(this.config)),
        },
        tx,
      );
      if (!won) throw RxRequestErrors.unavailable();
      await this.requests.moveOffers(request.id, ['OPEN'], 'WON', now, { onlyPharmacyId: offer.pharmacyId }, tx);
      const taken = await this.requests.moveOffers(request.id, ['OPEN'], 'TAKEN', now, { exceptPharmacyId: offer.pharmacyId }, tx);
      await this.audit.record(
        { actorUserId: input.actorUserId, action: 'RX_REQUEST_ACCEPTED', resourceType: 'RxRequest', resourceId: request.id, context: { pharmacyId: offer.pharmacyId } },
        tx,
      );
      await this.write(
        [
          rxRequestEvents.accepted({ requestId: request.id, customerUserId: request.customerUserId, pharmacyName: names.get(offer.pharmacyId) }),
          ...(taken.length > 0
            ? [rxRequestEvents.withdrawn({ requestId: request.id, recipientUserIds: recipients(staff, taken), reason: RX_REQUEST_CLOSED_REASON.ACCEPTED_ELSEWHERE })]
            : []),
        ],
        tx,
      );
    });
    return (await this.requests.findById(request.id)) as RxRequestSnapshot;
  }

  async decline(input: RxRequestActorInput & { reason: string }, now = new Date()): Promise<RxRequestSnapshot> {
    const { request, offer } = await this.callerOffer(input);
    if (offer.status === 'WON') return this.release(input, now);
    if (offer.status !== 'OPEN') throw RxRequestErrors.unavailable('Your pharmacy has already answered this request.');

    await runWithOrderRetry(this.uow, async (tx) => {
      const moved = await this.requests.moveOffers(request.id, ['OPEN'], 'DECLINED', now, { onlyPharmacyId: offer.pharmacyId, reason: input.reason.trim() }, tx);
      if (moved.length === 0) throw RxRequestErrors.unavailable('Your pharmacy has already answered this request.');
      await this.audit.record(
        { actorUserId: input.actorUserId, action: 'RX_REQUEST_DECLINED', resourceType: 'RxRequest', resourceId: request.id, context: { pharmacyId: offer.pharmacyId, reason: input.reason.trim() } },
        tx,
      );
      if (await this.endIfNobodyLeft(request.id, now, tx)) {
        await this.write([rxRequestEvents.ended({ requestId: request.id, customerUserId: request.customerUserId, status: 'NO_PHARMACY' })], tx);
      }
    });
    return (await this.requests.findById(request.id)) as RxRequestSnapshot;
  }

  /** The accepting pharmacy cannot fill it after all: it is offered to the others again. */
  async release(input: RxRequestActorInput & { reason?: string }, now = new Date()): Promise<RxRequestSnapshot> {
    const { request, offer } = await this.callerOffer(input);
    if (offer.status !== 'WON' || request.status !== 'CLAIMED') throw RxRequestErrors.unavailable('Your pharmacy does not hold this request.');
    const staff = await this.staffOf(request);
    await runWithOrderRetry(this.uow, async (tx) => {
      const events = await this.letGoIn(request, staff, offer.pharmacyId, 'DECLINED', input.reason?.trim() || 'released', input.actorUserId, now, tx);
      if (events.length === 0) throw RxRequestErrors.unavailable('Your pharmacy does not hold this request.');
      await this.write(events, tx);
    });
    return (await this.requests.findById(request.id)) as RxRequestSnapshot;
  }

  async cancel(input: { requestId: string; customerUserId: string }, now = new Date()): Promise<RxRequestSnapshot> {
    const request = await this.requests.findById(input.requestId);
    if (!request || request.customerUserId !== input.customerUserId) throw RxRequestErrors.notFound();
    if (!(LIVE_STATUSES as readonly string[]).includes(request.status)) throw RxRequestErrors.unavailable('This request has already ended.');

    const staff = await this.staffOf(request);
    await runWithOrderRetry(this.uow, async (tx) => {
      const closed = await this.requests.close(request.id, [...LIVE_STATUSES], 'CANCELLED', RX_REQUEST_CLOSED_REASON.CANCELLED, now, tx);
      if (!closed) throw RxRequestErrors.unavailable('This request has already ended.');
      const moved = await this.requests.moveOffers(request.id, ['OPEN', 'WON', 'TAKEN'], 'CLOSED', now, { reason: RX_REQUEST_CLOSED_REASON.CANCELLED }, tx);
      await this.audit.record(
        { actorUserId: input.customerUserId, action: 'RX_REQUEST_CANCELLED', resourceType: 'RxRequest', resourceId: request.id, context: {} },
        tx,
      );
      if (moved.length > 0) {
        await this.write([rxRequestEvents.withdrawn({ requestId: request.id, recipientUserIds: recipients(staff, moved), reason: RX_REQUEST_CLOSED_REASON.CANCELLED })], tx);
      }
    });
    return (await this.requests.findById(request.id)) as RxRequestSnapshot;
  }

  /**
   * The sweeper's step for one due request it has locked: an offer window that ended unaccepted, or
   * an acceptance not quoted in time. Runs in the sweeper's transaction; returns the events to write
   * after it commits.
   */
  async settleDue(request: RxRequestSnapshot, now: Date, tx: unknown): Promise<number> {
    const staff = await this.staffOf(request);
    const events = await this.settleDueEvents(request, staff, now, tx);
    await this.write(events, tx);
    return events.length;
  }

  private async settleDueEvents(request: RxRequestSnapshot, staff: Map<string, string[]>, now: Date, tx: unknown): Promise<DomainEvent<unknown>[]> {
    if (request.status === 'OPEN' && request.expiresAt <= now) {
      const closed = await this.requests.close(request.id, ['OPEN'], 'EXPIRED', RX_REQUEST_CLOSED_REASON.EXPIRED, now, tx);
      if (!closed) return [];
      const moved = await this.requests.moveOffers(request.id, ['OPEN'], 'CLOSED', now, { reason: RX_REQUEST_CLOSED_REASON.EXPIRED }, tx);
      await this.audit.record({ actorUserId: null, action: 'RX_REQUEST_EXPIRED', resourceType: 'RxRequest', resourceId: request.id, context: {} }, tx);
      return [
        rxRequestEvents.ended({ requestId: request.id, customerUserId: request.customerUserId, status: 'EXPIRED' }),
        ...(moved.length > 0 ? [rxRequestEvents.withdrawn({ requestId: request.id, recipientUserIds: recipients(staff, moved), reason: RX_REQUEST_CLOSED_REASON.EXPIRED })] : []),
      ];
    }
    if (request.status === 'CLAIMED' && request.claimExpiresAt && request.claimExpiresAt <= now && request.claimedPharmacyId) {
      return this.letGoIn(request, staff, request.claimedPharmacyId, 'LAPSED', RX_REQUEST_CLOSED_REASON.CLAIM_LAPSED, null, now, tx);
    }
    return [];
  }

  // ---- internals ------------------------------------------------------------------------------

  /** The caller's pharmacy's offer on this request; the caller must be a PHARMACIST there. */
  private async callerOffer(input: RxRequestActorInput): Promise<{ request: RxRequestSnapshot; offer: RxRequestOfferSnapshot }> {
    const [request, mine] = await Promise.all([this.requests.findById(input.requestId), this.pharmacies.pharmaciesWherePharmacist(input.actorUserId)]);
    const pharmacyIds = new Set(mine.map((m) => m.pharmacyId));
    const offer = request?.offers.find((o) => pharmacyIds.has(o.pharmacyId));
    if (!request || !offer) throw RxRequestErrors.notFound();
    return { request, offer };
  }

  private async letGoIn(
    request: RxRequestSnapshot,
    staff: Map<string, string[]>,
    pharmacyId: string,
    offerStatus: 'DECLINED' | 'LAPSED',
    reason: string,
    actorUserId: string | null,
    now: Date,
    tx: unknown,
  ): Promise<DomainEvent<unknown>[]> {
    const reofferUntil = new Date(Math.max(request.expiresAt.getTime(), RxRequestPolicy.addMinutes(now, RxRequestPolicy.offerMinutes(this.config)).getTime()));
    const released = await this.requests.release(request.id, pharmacyId, reofferUntil, tx);
    if (!released) return [];
    await this.requests.moveOffers(request.id, ['WON'], offerStatus, now, { onlyPharmacyId: pharmacyId, reason }, tx);
    const reopened = await this.requests.moveOffers(request.id, ['TAKEN'], 'OPEN', now, {}, tx);
    await this.audit.record(
      { actorUserId, action: offerStatus === 'LAPSED' ? 'RX_REQUEST_CLAIM_LAPSED' : 'RX_REQUEST_RELEASED', resourceType: 'RxRequest', resourceId: request.id, context: { pharmacyId, reason } },
      tx,
    );
    const ended = await this.endIfNobodyLeft(request.id, now, tx);
    if (ended) return [rxRequestEvents.ended({ requestId: request.id, customerUserId: request.customerUserId, status: 'NO_PHARMACY' })];
    return [
      rxRequestEvents.reopened({ requestId: request.id, customerUserId: request.customerUserId }),
      rxRequestEvents.reoffered({ requestId: request.id, recipientUserIds: recipients(staff, reopened) }),
    ];
  }

  /** An open request with no open offer left has nobody to go to: it ends `NO_PHARMACY`. */
  private async endIfNobodyLeft(requestId: string, now: Date, tx: unknown): Promise<boolean> {
    const fresh = await this.requests.findById(requestId, tx);
    if (!fresh || fresh.status !== 'OPEN' || fresh.offers.some((o) => o.status === 'OPEN')) return false;
    return this.requests.close(requestId, ['OPEN'], 'NO_PHARMACY', RX_REQUEST_CLOSED_REASON.NO_PHARMACY, now, tx);
  }

  /** The owners and pharmacists of every pharmacy the request was offered to. */
  private staffOf(request: RxRequestSnapshot): Promise<Map<string, string[]>> {
    return this.pharmacies.staffUserIds(request.offers.map((o) => o.pharmacyId));
  }

  private async write(events: DomainEvent<unknown>[], tx: unknown): Promise<void> {
    for (const e of events) await this.outbox.write(e, tx as never);
  }
}

function recipients(staff: Map<string, string[]>, pharmacyIds: string[]): string[] {
  return [...new Set(pharmacyIds.flatMap((id) => staff.get(id) ?? []))];
}
