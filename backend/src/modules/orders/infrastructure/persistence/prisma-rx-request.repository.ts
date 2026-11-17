import { Injectable } from '@nestjs/common';
import { Prisma, RxRequest as PrismaRxRequest, RxRequestOffer as PrismaRxRequestOffer } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IRxRequestRepository,
  NewRxRequestData,
  NewRxRequestOfferData,
  RxClaim,
  RxRequestOfferSnapshot,
  RxRequestOfferStatus,
  RxRequestSnapshot,
  RxRequestStatus,
} from '../../domain/repositories/rx-request.repository';

type Client = PrismaService | Prisma.TransactionClient;
type Row = PrismaRxRequest & { offers: PrismaRxRequestOffer[] };

const withOffers = { offers: { orderBy: { distanceMeters: 'asc' as const } } };

function toOffer(row: PrismaRxRequestOffer): RxRequestOfferSnapshot {
  return {
    id: row.id,
    requestId: row.requestId,
    pharmacyId: row.pharmacyId,
    branchId: row.branchId,
    distanceMeters: row.distanceMeters,
    status: row.status,
    respondedAt: row.respondedAt,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function toSnapshot(row: Row): RxRequestSnapshot {
  return {
    id: row.id,
    customerUserId: row.customerUserId,
    prescriptionId: row.prescriptionId,
    addressId: row.addressId,
    deliveryLat: row.deliveryLat,
    deliveryLng: row.deliveryLng,
    prescriptionIssueDate: row.prescriptionIssueDate,
    note: row.note,
    status: row.status,
    expiresAt: row.expiresAt,
    claimedPharmacyId: row.claimedPharmacyId,
    claimedBranchId: row.claimedBranchId,
    claimedByUserId: row.claimedByUserId,
    claimedAt: row.claimedAt,
    claimExpiresAt: row.claimExpiresAt,
    quote: row.quote,
    quotedAt: row.quotedAt,
    quoteExpiresAt: row.quoteExpiresAt,
    orderId: row.orderId,
    closedReason: row.closedReason,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    offers: row.offers.map(toOffer),
  };
}

/** Work 134: Prisma adapter for `IRxRequestRepository`. */
@Injectable()
export class PrismaRxRequestRepository implements IRxRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  private db(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient | undefined) ?? this.prisma;
  }

  async create(data: NewRxRequestData, offers: NewRxRequestOfferData[], tx?: unknown): Promise<RxRequestSnapshot> {
    const row = await this.db(tx).rxRequest.create({
      data: { ...data, offers: { create: offers } },
      include: withOffers,
    });
    return toSnapshot(row);
  }

  async findById(id: string, tx?: unknown): Promise<RxRequestSnapshot | null> {
    const row = await this.db(tx).rxRequest.findUnique({ where: { id }, include: withOffers });
    return row ? toSnapshot(row) : null;
  }

  async findByPrescriptionId(prescriptionId: string, tx?: unknown): Promise<RxRequestSnapshot | null> {
    const row = await this.db(tx).rxRequest.findUnique({ where: { prescriptionId }, include: withOffers });
    return row ? toSnapshot(row) : null;
  }

  async listByCustomer(customerUserId: string, page: number, size: number) {
    const where = { customerUserId };
    const [rows, total] = await Promise.all([
      this.prisma.rxRequest.findMany({ where, include: withOffers, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.rxRequest.count({ where }),
    ]);
    return { items: rows.map(toSnapshot), total };
  }

  async listOfferedTo(pharmacyIds: string[], offerStatuses: RxRequestOfferStatus[], page: number, size: number) {
    if (pharmacyIds.length === 0) return { items: [], total: 0 };
    const where: Prisma.RxRequestWhereInput = { offers: { some: { pharmacyId: { in: pharmacyIds }, status: { in: offerStatuses } } } };
    const [rows, total] = await Promise.all([
      this.prisma.rxRequest.findMany({ where, include: withOffers, orderBy: { createdAt: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.rxRequest.count({ where }),
    ]);
    return { items: rows.map(toSnapshot), total };
  }

  async claim(claim: RxClaim, tx?: unknown): Promise<boolean> {
    // One conditional UPDATE: a concurrent claim re-checks `status = OPEN` after the first commits
    // (or, under Serializable, fails and is retried) and so updates nothing.
    const result = await this.db(tx).rxRequest.updateMany({
      where: {
        id: claim.requestId,
        status: 'OPEN',
        expiresAt: { gt: claim.now },
        offers: { some: { pharmacyId: claim.pharmacyId, status: 'OPEN' } },
      },
      data: {
        status: 'CLAIMED',
        claimedPharmacyId: claim.pharmacyId,
        claimedBranchId: claim.branchId,
        claimedByUserId: claim.userId,
        claimedAt: claim.now,
        claimExpiresAt: claim.claimExpiresAt,
      },
    });
    return result.count === 1;
  }

  async release(requestId: string, pharmacyId: string, expiresAt: Date, tx?: unknown): Promise<boolean> {
    const result = await this.db(tx).rxRequest.updateMany({
      where: { id: requestId, status: 'CLAIMED', claimedPharmacyId: pharmacyId },
      data: { status: 'OPEN', expiresAt, claimedPharmacyId: null, claimedBranchId: null, claimedByUserId: null, claimedAt: null, claimExpiresAt: null },
    });
    return result.count === 1;
  }

  async close(requestId: string, from: RxRequestStatus[], status: RxRequestStatus, reason: string, now: Date, tx?: unknown): Promise<boolean> {
    const result = await this.db(tx).rxRequest.updateMany({
      where: { id: requestId, status: { in: from } },
      data: { status, closedReason: reason, closedAt: now },
    });
    return result.count === 1;
  }

  async moveOffers(
    requestId: string,
    from: RxRequestOfferStatus[],
    to: RxRequestOfferStatus,
    now: Date,
    options: { onlyPharmacyId?: string; exceptPharmacyId?: string; reason?: string } = {},
    tx?: unknown,
  ): Promise<string[]> {
    const db = this.db(tx);
    const where: Prisma.RxRequestOfferWhereInput = {
      requestId,
      status: { in: from },
      ...(options.onlyPharmacyId ? { pharmacyId: options.onlyPharmacyId } : {}),
      ...(options.exceptPharmacyId ? { pharmacyId: { not: options.exceptPharmacyId } } : {}),
    };
    const rows = await db.rxRequestOffer.findMany({ where, select: { id: true, pharmacyId: true } });
    if (rows.length === 0) return [];
    await db.rxRequestOffer.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: { in: from } },
      data: { status: to, respondedAt: now, ...(options.reason !== undefined ? { reason: options.reason } : {}) },
    });
    return rows.map((r) => r.pharmacyId);
  }

  async lockNextDue(now: Date, excludeIds: readonly string[], tx: unknown): Promise<RxRequestSnapshot | null> {
    const db = this.db(tx);
    const exclude = excludeIds.length > 0 ? Prisma.sql`AND r."id" NOT IN (${Prisma.join([...excludeIds])})` : Prisma.empty;
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT r."id" FROM "rx_requests" r
      WHERE ((r."status" = 'OPEN' AND r."expiresAt" <= ${now})
          OR (r."status" = 'CLAIMED' AND r."claimExpiresAt" <= ${now}))
      ${exclude}
      ORDER BY r."updatedAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return null;
    return this.findById(rows[0].id, tx);
  }
}
