import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { InventoryListing, InventoryListingProps } from '../../domain/entities/inventory-listing.entity';
import {
  AvailabilityRow,
  IListingRepository,
  ListingFilter,
} from '../../domain/repositories/listing.repository';

type Client = PrismaService | Prisma.TransactionClient;

@Injectable()
export class PrismaListingRepository implements IListingRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: unknown): Client {
    return (tx as Prisma.TransactionClient) ?? this.prisma;
  }

  async findById(id: string, tx?: unknown): Promise<InventoryListing | null> {
    const row = await this.client(tx).inventoryListing.findUnique({ where: { id } });
    return row && !row.deletedAt ? InventoryListing.rehydrate(row as InventoryListingProps) : null;
  }

  async findByBranchAndProduct(
    branchId: string,
    catalogProductId: string,
    tx?: unknown,
  ): Promise<InventoryListing | null> {
    const row = await this.client(tx).inventoryListing.findFirst({
      where: { branchId, catalogProductId, deletedAt: null },
    });
    return row ? InventoryListing.rehydrate(row as InventoryListingProps) : null;
  }

  /**
   * `SELECT ... FOR UPDATE` (module-04 §8) — requires an interactive transaction client; `tx`
   * must be the handle passed into `IUnitOfWork.run`, never the bare `PrismaService`.
   */
  async lockForUpdate(id: string, tx: unknown): Promise<InventoryListing | null> {
    const client = tx as Prisma.TransactionClient;
    const rows = await client.$queryRaw<InventoryListingProps[]>`
      SELECT * FROM "inventory_listings" WHERE "id" = ${id} AND "deletedAt" IS NULL FOR UPDATE
    `;
    return rows[0] ? InventoryListing.rehydrate(rows[0]) : null;
  }

  async create(listing: InventoryListing, tx?: unknown): Promise<void> {
    const l = listing.toProps();
    await this.client(tx).inventoryListing.create({
      data: {
        id: l.id,
        pharmacyId: l.pharmacyId,
        branchId: l.branchId,
        catalogProductId: l.catalogProductId,
        price: l.price,
        currency: l.currency,
        onHand: l.onHand,
        reserved: l.reserved,
        sellable: l.sellable,
        isEnabled: l.isEnabled,
        storageRequirement: l.storageRequirement,
      },
    });
  }

  async updateCache(
    id: string,
    patch: { onHand?: number; reserved?: number; sellable?: number },
    tx?: unknown,
  ): Promise<void> {
    await this.client(tx).inventoryListing.update({
      where: { id },
      data: {
        ...(patch.onHand !== undefined ? { onHand: patch.onHand } : {}),
        ...(patch.reserved !== undefined ? { reserved: patch.reserved } : {}),
        ...(patch.sellable !== undefined ? { sellable: patch.sellable } : {}),
      },
    });
  }

  async updatePriceEnable(
    id: string,
    patch: { price?: number; isEnabled?: boolean },
    tx?: unknown,
  ): Promise<void> {
    await this.client(tx).inventoryListing.update({
      where: { id },
      data: {
        ...(patch.price !== undefined ? { price: patch.price } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
      },
    });
  }

  async softDelete(id: string, tx?: unknown): Promise<void> {
    await this.client(tx).inventoryListing.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async findMany(
    filter: ListingFilter,
    tx?: unknown,
  ): Promise<{ items: InventoryListing[]; total: number }> {
    const client = this.client(tx);
    const where = {
      pharmacyId: filter.pharmacyId,
      deletedAt: null,
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.catalogProductId ? { catalogProductId: filter.catalogProductId } : {}),
    };
    const [rows, total] = await Promise.all([
      client.inventoryListing.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.size,
        take: filter.size,
      }),
      client.inventoryListing.count({ where }),
    ]);
    return { items: rows.map((r) => InventoryListing.rehydrate(r as InventoryListingProps)), total };
  }

  async findAvailability(catalogProductId: string, now: Date, limit: number): Promise<AvailabilityRow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        pharmacyId: string;
        branchId: string;
        listingId: string;
        price: number;
        currency: string;
        sellable: number;
        storageRequirement: string;
        lat: number | null;
        lng: number | null;
      }>
    >`
      SELECT
        il."id" AS "listingId",
        il."pharmacyId" AS "pharmacyId",
        il."branchId" AS "branchId",
        il."price" AS "price",
        il."currency" AS "currency",
        il."sellable" AS "sellable",
        il."storageRequirement" AS "storageRequirement",
        b."lat" AS "lat",
        b."lng" AS "lng"
      FROM "inventory_listings" il
      JOIN "pharmacies" p ON p."id" = il."pharmacyId"
      JOIN "branches" b ON b."id" = il."branchId"
      WHERE il."catalogProductId" = ${catalogProductId}
        AND il."isEnabled" = true
        AND il."deletedAt" IS NULL
        AND il."sellable" > 0
        AND b."isActive" = true
        AND p."deletedAt" IS NULL
        AND p."transactingStatus" = 'ACTIVE'
        AND p."licenseStatus" = 'VALID'
        AND (p."licenseExpiresAt" IS NULL OR p."licenseExpiresAt" > ${now})
      LIMIT ${limit}
    `;
    return rows;
  }
}
