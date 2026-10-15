import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  IReservationIntegrityReadPort,
  ReservationIntegrityFilter,
  ReservationIntegrityPage,
  ReservationIntegritySummary,
} from '../../application/ports/inbound/reservation-integrity-read.port';

/** Dispatched, by `DispatchStockCommand`'s own guard (`findDispatchMovements`): a `DISPATCH` movement references it. */
const linkedDispatch = Prisma.sql`EXISTS (SELECT 1 FROM "stock_movements" m WHERE m."reservationId" = r."id" AND m."type" = 'DISPATCH')`;

/** A reservation still counted in its listing's `reserved` — see the port doc for the writer-by-writer derivation. */
export const contributingReservation = Prisma.sql`(r."status" = 'HELD' OR (r."status" = 'CONFIRMED' AND NOT ${linkedDispatch}))`;

/**
 * One row per live listing in scope: stored counter, derived counter, contributing count, and whether it
 * is undetermined (an undispatched-looking `CONFIRMED` reservation next to a `DISPATCH` movement that has
 * no `reservationId`). Reservations are aggregated per listing BEFORE the join, so neither batches nor
 * movements can multiply a quantity; the movement checks are `EXISTS` probes.
 */
export function classifiedListings(f: ReservationIntegrityFilter): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`il."deletedAt" IS NULL`];
  if (f.pharmacyId) conditions.push(Prisma.sql`il."pharmacyId" = ${f.pharmacyId}`);
  if (f.branchId) conditions.push(Prisma.sql`il."branchId" = ${f.branchId}`);
  return Prisma.sql`
    WITH live AS (
      SELECT il."id", il."pharmacyId", il."branchId", il."catalogProductId", il."reserved"
        FROM "inventory_listings" il
       WHERE ${Prisma.join(conditions, ' AND ')}
    ),
    contrib AS (
      SELECT r."listingId", SUM(r."quantity")::int AS "derived", COUNT(*)::int AS "n"
        FROM "stock_reservations" r JOIN live ON live."id" = r."listingId"
       WHERE ${contributingReservation}
       GROUP BY r."listingId"
    ),
    undetermined AS (
      SELECT DISTINCT r."listingId"
        FROM "stock_reservations" r JOIN live ON live."id" = r."listingId"
       WHERE r."status" = 'CONFIRMED' AND NOT ${linkedDispatch}
         AND EXISTS (SELECT 1 FROM "stock_movements" lm
                      WHERE lm."listingId" = r."listingId" AND lm."type" = 'DISPATCH' AND lm."reservationId" IS NULL)
    ),
    classified AS (
      SELECT live."id", live."pharmacyId", live."branchId", live."catalogProductId",
             live."reserved" AS "storedReserved",
             COALESCE(c."derived", 0) AS "derived",
             COALESCE(c."n", 0) AS "n",
             (u."listingId" IS NOT NULL) AS "undetermined"
        FROM live
        LEFT JOIN contrib c ON c."listingId" = live."id"
        LEFT JOIN undetermined u ON u."listingId" = live."id"
    )`;
}

const DISCREPANT = Prisma.sql`NOT "undetermined" AND "storedReserved" <> "derived"`;

interface DiscrepancyRow {
  id: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  storedReserved: number;
  derived: number;
  n: number;
}

interface SummaryRow {
  checked: bigint;
  consistent: bigint;
  discrepant: bigint;
  undetermined: bigint;
}

/**
 * Database-side classification for Work 54 (port: `RESERVATION_INTEGRITY_READ_PORT`). Each call reads in
 * one REPEATABLE READ snapshot, so a page and its total (or the four summary counts) describe the same
 * state even while reservations change. Nothing is written.
 */
@Injectable()
export class PrismaReservationIntegrityReadAdapter implements IReservationIntegrityReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async listDiscrepancies(f: ReservationIntegrityFilter, page: number, size: number): Promise<ReservationIntegrityPage> {
    const generatedAt = new Date();
    const cte = classifiedListings(f);
    const [rows, [{ count }]] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<DiscrepancyRow[]>`
          ${cte}
          SELECT "id", "pharmacyId", "branchId", "catalogProductId", "storedReserved", "derived", "n"
            FROM classified
           WHERE ${DISCREPANT}
           ORDER BY ABS("storedReserved" - "derived") DESC, "id" ASC
           LIMIT ${size} OFFSET ${(page - 1) * size}`,
        this.prisma.$queryRaw<Array<{ count: bigint }>>`${cte} SELECT COUNT(*) AS "count" FROM classified WHERE ${DISCREPANT}`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      generatedAt,
      items: rows.map((r) => ({
        listingId: r.id,
        pharmacyId: r.pharmacyId,
        branchId: r.branchId,
        catalogProductId: r.catalogProductId,
        storedReserved: r.storedReserved,
        reservationDerivedReserved: r.derived,
        difference: r.storedReserved - r.derived,
        contributingReservations: r.n,
      })),
      total: Number(count),
      page,
      size,
    };
  }

  async getSummary(f: ReservationIntegrityFilter): Promise<ReservationIntegritySummary> {
    const generatedAt = new Date();
    const [[row]] = await this.prisma.$transaction(
      [
        this.prisma.$queryRaw<SummaryRow[]>`
          ${classifiedListings(f)}
          SELECT COUNT(*) AS "checked",
                 COUNT(*) FILTER (WHERE NOT "undetermined" AND "storedReserved" = "derived") AS "consistent",
                 COUNT(*) FILTER (WHERE ${DISCREPANT}) AS "discrepant",
                 COUNT(*) FILTER (WHERE "undetermined") AS "undetermined"
            FROM classified`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      generatedAt,
      listingsChecked: Number(row.checked),
      listingsConsistent: Number(row.consistent),
      listingsWithDiscrepancy: Number(row.discrepant),
      listingsUndetermined: Number(row.undetermined),
    };
  }
}
