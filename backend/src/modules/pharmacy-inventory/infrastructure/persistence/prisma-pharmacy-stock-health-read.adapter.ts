import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  EXPIRING_SOON_DAYS,
  IPharmacyStockHealthReadPort,
  LOW_STOCK_THRESHOLD,
  PharmacyStockHealth,
} from '../../application/ports/inbound/pharmacy-stock-health-read.port';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Work 115: counts only, over `inventory_listings` and `stock_batches`. */
@Injectable()
export class PrismaPharmacyStockHealthReadAdapter implements IPharmacyStockHealthReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async summarize(pharmacyIds: string[], now = new Date()): Promise<PharmacyStockHealth> {
    if (pharmacyIds.length === 0) {
      return { listings: 0, enabledListings: 0, outOfStock: 0, lowStock: 0, batchesExpiringSoon: 0, batchesExpired: 0 };
    }
    const live = { pharmacyId: { in: pharmacyIds }, deletedAt: null };
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * DAY_MS);
    const [listings, enabledListings, outOfStock, lowStock, batchesExpiringSoon, batchesExpired] = await Promise.all([
      this.prisma.inventoryListing.count({ where: live }),
      this.prisma.inventoryListing.count({ where: { ...live, isEnabled: true } }),
      this.prisma.inventoryListing.count({ where: { ...live, isEnabled: true, sellable: { lte: 0 } } }),
      this.prisma.inventoryListing.count({ where: { ...live, isEnabled: true, sellable: { gt: 0, lt: LOW_STOCK_THRESHOLD } } }),
      this.prisma.stockBatch.count({ where: { quantity: { gt: 0 }, expiryDate: { gte: now, lte: soon }, listing: live } }),
      this.prisma.stockBatch.count({ where: { quantity: { gt: 0 }, expiryDate: { lt: now }, listing: live } }),
    ]);
    return { listings, enabledListings, outOfStock, lowStock, batchesExpiringSoon, batchesExpired };
  }
}
