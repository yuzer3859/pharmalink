import { Injectable } from '@nestjs/common';
import {
  MatchCandidate as PrismaMatchCandidate,
  MatchRequest as PrismaMatchRequest,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  ChosenResult,
  IMatchRepository,
  MatchCandidateSnapshot,
  MatchRequestSnapshot,
  MatchStatusUpdate,
  NewMatchCandidateData,
  NewMatchRequestData,
} from '../../domain/repositories/match.repository';

type Client = PrismaService | Prisma.TransactionClient;

function toMatchRequestSnapshot(row: PrismaMatchRequest): MatchRequestSnapshot {
  return {
    id: row.id,
    orderId: row.orderId,
    customerUserId: row.customerUserId,
    deliveryLat: row.deliveryLat,
    deliveryLng: row.deliveryLng,
    status: row.status,
    strategy: row.strategy,
    chosenResult: (row.chosenResult as unknown as ChosenResult | null) ?? null,
    overridePharmacyId: row.overridePharmacyId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCandidateSnapshot(row: PrismaMatchCandidate): MatchCandidateSnapshot {
  return {
    id: row.id,
    matchRequestId: row.matchRequestId,
    pharmacyId: row.pharmacyId,
    branchId: row.branchId,
    coverage: row.coverage,
    totalPrice: row.totalPrice,
    distanceMeters: row.distanceMeters,
    rating: row.rating,
    rank: row.rank,
    createdAt: row.createdAt,
  };
}

/**
 * Maps `MatchStatusUpdate.chosenResult` to a Prisma `Json?` write value. Prisma requires the
 * sentinel `Prisma.DbNull` (not a plain `null`) to set a nullable `Json` column to SQL `NULL`
 * from an `update()` call — passing `undefined` (the default when the caller omits the field)
 * leaves the column untouched.
 */
function chosenResultToJsonInput(
  value: ChosenResult | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Prisma adapter for `IMatchRepository` (module-05 §3.6/§3.7, §11) — persists the `MatchRequest`
 * aggregate root plus its child `MatchCandidate` ranked-snapshot rows via `match_requests` /
 * `match_candidates` (`prisma/schema/05-prescription.prisma`). Every mutating method uses the
 * caller-supplied transaction handle when given; this adapter never opens its own
 * `$transaction()` (§12 — the Unit of Work owns the boundary, and ADR-014's two-transaction seam
 * with Module 04's `IInventoryPort` is an application-layer ordering concern, not something this
 * repository can or should enforce).
 */
@Injectable()
export class PrismaMatchRepository implements IMatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<MatchRequestSnapshot | null> {
    const row = await this.client(tx).matchRequest.findUnique({ where: { id } });
    return row ? toMatchRequestSnapshot(row) : null;
  }

  async createWithCandidates(
    data: NewMatchRequestData,
    candidates: NewMatchCandidateData[],
    tx?: unknown,
  ): Promise<{ matchRequest: MatchRequestSnapshot; candidates: MatchCandidateSnapshot[] }> {
    const client = this.client(tx);
    const matchRequestRow = await client.matchRequest.create({
      data: {
        orderId: data.orderId ?? null,
        customerUserId: data.customerUserId,
        deliveryLat: data.deliveryLat ?? null,
        deliveryLng: data.deliveryLng ?? null,
        strategy: data.strategy,
      },
    });
    const candidateRows = await Promise.all(
      candidates.map((candidate) =>
        client.matchCandidate.create({
          data: {
            matchRequestId: matchRequestRow.id,
            pharmacyId: candidate.pharmacyId,
            branchId: candidate.branchId,
            coverage: candidate.coverage,
            totalPrice: candidate.totalPrice,
            distanceMeters: candidate.distanceMeters ?? null,
            rating: candidate.rating ?? null,
            rank: candidate.rank,
          },
        }),
      ),
    );
    return {
      matchRequest: toMatchRequestSnapshot(matchRequestRow),
      candidates: candidateRows.map(toCandidateSnapshot),
    };
  }

  async listCandidates(matchRequestId: string, tx?: unknown): Promise<MatchCandidateSnapshot[]> {
    const rows = await this.client(tx).matchCandidate.findMany({
      where: { matchRequestId },
      orderBy: { rank: 'asc' },
    });
    return rows.map(toCandidateSnapshot);
  }

  async updateStatus(id: string, update: MatchStatusUpdate, tx?: unknown): Promise<void> {
    await this.client(tx).matchRequest.update({
      where: { id },
      data: {
        status: update.status,
        chosenResult: chosenResultToJsonInput(update.chosenResult),
        overridePharmacyId: update.overridePharmacyId,
      },
    });
  }

  async replaceCandidates(
    matchRequestId: string,
    candidates: NewMatchCandidateData[],
    tx?: unknown,
  ): Promise<MatchCandidateSnapshot[]> {
    const client = this.client(tx);
    await client.matchCandidate.deleteMany({ where: { matchRequestId } });
    const rows = await Promise.all(
      candidates.map((candidate) =>
        client.matchCandidate.create({
          data: {
            matchRequestId,
            pharmacyId: candidate.pharmacyId,
            branchId: candidate.branchId,
            coverage: candidate.coverage,
            totalPrice: candidate.totalPrice,
            distanceMeters: candidate.distanceMeters ?? null,
            rating: candidate.rating ?? null,
            rank: candidate.rank,
          },
        }),
      ),
    );
    return rows.map(toCandidateSnapshot);
  }
}
