import { createDomainEvent, DomainEvent } from '../../../shared/events/domain-event';

/**
 * Work 134: the events of a prescription request. Each names its recipients, worked out when the
 * state changed: the customer, or the owner and pharmacists of the pharmacies concerned. Module 13
 * tells each of them; no prescription content and no customer contact data is carried.
 */
export const RxRequestEventType = {
  /** To the pharmacies it is offered to: a new request they can accept. */
  Offered: 'rx_request.offered',
  /** To the pharmacies that can no longer accept it: another took it, or it ended. */
  Withdrawn: 'rx_request.withdrawn',
  /** To the pharmacies it is offered to again, after the accepting one let it go. */
  Reoffered: 'rx_request.reoffered',
  /** To the customer: a pharmacy accepted it. */
  Accepted: 'rx_request.accepted',
  /** To the customer: the pharmacy let it go; it is offered to the others again. */
  Reopened: 'rx_request.reopened',
  /** To the customer: it ended without a pharmacy (nobody in time, or nobody available). */
  Ended: 'rx_request.ended',
} as const;

export interface RxRequestPharmaciesPayload {
  requestId: string;
  recipientUserIds: string[];
  /** For `withdrawn`: `accepted-by-another-pharmacy`, `no-pharmacy-accepted-in-time` or `cancelled-by-customer`. */
  reason?: string;
}

export interface RxRequestCustomerPayload {
  requestId: string;
  customerUserId: string;
  /** For `accepted`: the pharmacy's display name. */
  pharmacyName?: string;
  /** For `ended`: `EXPIRED` or `NO_PHARMACY`. */
  status?: string;
}

function event<T extends { requestId: string }>(type: string, payload: T): DomainEvent<T> {
  return createDomainEvent({ type, aggregateType: 'RxRequest', aggregateId: payload.requestId, payload });
}

export const rxRequestEvents = {
  offered: (p: RxRequestPharmaciesPayload) => event(RxRequestEventType.Offered, p),
  withdrawn: (p: RxRequestPharmaciesPayload) => event(RxRequestEventType.Withdrawn, p),
  reoffered: (p: RxRequestPharmaciesPayload) => event(RxRequestEventType.Reoffered, p),
  accepted: (p: RxRequestCustomerPayload) => event(RxRequestEventType.Accepted, p),
  reopened: (p: RxRequestCustomerPayload) => event(RxRequestEventType.Reopened, p),
  ended: (p: RxRequestCustomerPayload) => event(RxRequestEventType.Ended, p),
};
