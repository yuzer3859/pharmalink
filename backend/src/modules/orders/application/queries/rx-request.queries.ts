import { Inject, Injectable } from '@nestjs/common';
import {
  IPrescriptionReviewRoutingPort,
  PRESCRIPTION_REVIEW_ROUTING_PORT,
} from '../../../prescription-matching/application/ports/inbound/prescription-review-routing.port';
import {
  IRxRequestRepository,
  RX_REQUEST_REPOSITORY,
  RxRequestOfferStatus,
  RxRequestSnapshot,
} from '../../domain/repositories/rx-request.repository';
import { RxRequestErrors } from '../commands/rx-request.commands';
import { IRxRequestPharmaciesPort, RX_REQUEST_PHARMACIES_PORT, RxPrescriptionSummary } from '../ports/outbound/rx-request-pharmacies.port';

/** What the customer sees of their request. No pharmacy is named until one accepts. */
export interface CustomerRxRequestView {
  id: string;
  status: RxRequestSnapshot['status'];
  prescriptionId: string;
  addressId: string;
  prescriptionIssueDate: Date;
  note: string | null;
  expiresAt: Date;
  /** How many pharmacies it was offered to, and how many are still considering it. */
  offeredTo: number;
  stillConsidering: number;
  pharmacy: { name: string | null; acceptedAt: Date | null; quoteDueAt: Date | null } | null;
  orderId: string | null;
  closedReason: string | null;
  closedAt: Date | null;
  createdAt: Date;
}

/** What a pharmacy sees of a request offered to it. */
export interface PharmacyRxRequestView {
  id: string;
  status: RxRequestSnapshot['status'];
  /** This pharmacy's offer: `OPEN` it can accept, `WON` it holds it, others are history. */
  offer: { status: RxRequestOfferStatus; branchId: string; distanceMeters: number; respondedAt: Date | null };
  /** True when this pharmacy holds it. */
  mine: boolean;
  customerName: string | null;
  prescription: RxPrescriptionSummary | null;
  prescriptionIssueDate: Date;
  note: string | null;
  expiresAt: Date;
  claimExpiresAt: Date | null;
  createdAt: Date;
}

const ACTIVE_OFFERS: RxRequestOfferStatus[] = ['OPEN', 'WON'];
const ALL_OFFERS: RxRequestOfferStatus[] = ['OPEN', 'WON', 'TAKEN', 'DECLINED', 'LAPSED', 'CLOSED'];

/** Work 134: reads of prescription requests, for the customer and for the pharmacies. */
@Injectable()
export class RxRequestQueries {
  constructor(
    @Inject(RX_REQUEST_REPOSITORY) private readonly requests: IRxRequestRepository,
    @Inject(RX_REQUEST_PHARMACIES_PORT) private readonly pharmacies: IRxRequestPharmaciesPort,
    @Inject(PRESCRIPTION_REVIEW_ROUTING_PORT) private readonly rxReview: IPrescriptionReviewRoutingPort,
  ) {}

  async listMine(customerUserId: string, page = 1, size = 20): Promise<{ items: CustomerRxRequestView[]; total: number }> {
    const { items, total } = await this.requests.listByCustomer(customerUserId, page, Math.min(size, 50));
    const names = await this.pharmacies.displayNames(items.map((r) => r.claimedPharmacyId).filter((id): id is string => !!id));
    return { items: items.map((r) => customerView(r, names)), total };
  }

  async getMine(customerUserId: string, requestId: string): Promise<CustomerRxRequestView> {
    const request = await this.requests.findById(requestId);
    if (!request || request.customerUserId !== customerUserId) throw RxRequestErrors.notFound();
    const names = await this.pharmacies.displayNames(request.claimedPharmacyId ? [request.claimedPharmacyId] : []);
    return customerView(request, names);
  }

  /** `scope` `active`: what the pharmacy can accept or holds; `all`: with its history. */
  async listForPharmacy(userId: string, scope: 'active' | 'all' = 'active', page = 1, size = 20): Promise<{ items: PharmacyRxRequestView[]; total: number }> {
    const mine = await this.pharmacies.pharmaciesOfStaff(userId);
    const pharmacyIds = mine.map((m) => m.pharmacyId);
    const { items, total } = await this.requests.listOfferedTo(pharmacyIds, scope === 'all' ? ALL_OFFERS : ACTIVE_OFFERS, page, Math.min(size, 50));
    return { items: await this.pharmacyViews(items, new Set(pharmacyIds)), total };
  }

  async getForPharmacy(userId: string, requestId: string): Promise<PharmacyRxRequestView> {
    const mine = new Set((await this.pharmacies.pharmaciesOfStaff(userId)).map((m) => m.pharmacyId));
    const request = await this.requests.findById(requestId);
    if (!request || !request.offers.some((o) => mine.has(o.pharmacyId))) throw RxRequestErrors.notFound();
    return (await this.pharmacyViews([request], mine))[0];
  }

  /**
   * The prescription's file, for a PHARMACIST of a pharmacy the request is offered to now (its
   * offer `OPEN`) or that holds it (`WON`). The link is short-lived and access-logged by Module 05.
   */
  async fileLink(userId: string, requestId: string, ip?: string | null) {
    const [request, pharmacist] = await Promise.all([this.requests.findById(requestId), this.pharmacies.pharmaciesWherePharmacist(userId)]);
    const offer = request?.offers.find((o) => pharmacist.some((p) => p.pharmacyId === o.pharmacyId));
    if (!request || !offer) throw RxRequestErrors.notFound();
    if (!ACTIVE_OFFERS.includes(offer.status)) throw RxRequestErrors.unavailable();
    const organizationId = pharmacist.find((p) => p.pharmacyId === offer.pharmacyId)?.organizationId as string;
    return this.rxReview.offeredFileLink({ prescriptionId: request.prescriptionId, userId, organizationId, ip });
  }

  private async pharmacyViews(requests: RxRequestSnapshot[], mine: Set<string>): Promise<PharmacyRxRequestView[]> {
    const [names, prescriptions] = await Promise.all([
      this.pharmacies.customerNames(requests.map((r) => r.customerUserId)),
      this.pharmacies.prescriptionSummaries(requests.map((r) => r.prescriptionId)),
    ]);
    return requests.map((r) => {
      const offer = r.offers.find((o) => mine.has(o.pharmacyId)) as RxRequestSnapshot['offers'][number];
      return {
        id: r.id,
        status: r.status,
        offer: { status: offer.status, branchId: offer.branchId, distanceMeters: offer.distanceMeters, respondedAt: offer.respondedAt },
        mine: r.claimedPharmacyId === offer.pharmacyId && offer.status === 'WON',
        customerName: names.get(r.customerUserId) ?? null,
        prescription: prescriptions.get(r.prescriptionId) ?? null,
        prescriptionIssueDate: r.prescriptionIssueDate,
        note: r.note,
        expiresAt: r.expiresAt,
        claimExpiresAt: offer.status === 'WON' ? r.claimExpiresAt : null,
        createdAt: r.createdAt,
      };
    });
  }
}

function customerView(r: RxRequestSnapshot, names: Map<string, string>): CustomerRxRequestView {
  return {
    id: r.id,
    status: r.status,
    prescriptionId: r.prescriptionId,
    addressId: r.addressId,
    prescriptionIssueDate: r.prescriptionIssueDate,
    note: r.note,
    expiresAt: r.expiresAt,
    offeredTo: r.offers.length,
    stillConsidering: r.offers.filter((o) => o.status === 'OPEN').length,
    pharmacy: r.claimedPharmacyId
      ? { name: names.get(r.claimedPharmacyId) ?? null, acceptedAt: r.claimedAt, quoteDueAt: r.claimExpiresAt }
      : null,
    orderId: r.orderId,
    closedReason: r.closedReason,
    closedAt: r.closedAt,
    createdAt: r.createdAt,
  };
}
