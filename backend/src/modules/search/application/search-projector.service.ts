import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import {
  CATALOG_SEARCH_SOURCE_PORT,
  ICatalogSearchSourcePort,
  SearchProductSource,
} from '../../catalog/application/ports/inbound/catalog-search-source.port';
import {
  IPharmacySearchSourcePort,
  PHARMACY_SEARCH_SOURCE_PORT,
} from '../../pharmacy-inventory/application/ports/inbound/pharmacy-search-source.port';

const LOCALE = 'en';

/** The text a product is found by: both names, generic and brand names, maker, strength, categories. */
export function productSearchText(p: SearchProductSource): string {
  return [
    p.nameEn,
    p.nameAm,
    p.genericName,
    p.brandName,
    p.manufacturer,
    p.dosageForm,
    p.strength,
    ...p.categories.flatMap((c) => [c.nameEn, c.nameAm, c.slug]),
  ]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(' ')
    .toLowerCase();
}

/**
 * Work 98: Module 14's projector (module-14 §7). It keeps two Search-owned read models in step
 * with Modules 03 and 04:
 *  - `search_documents`: one `PRODUCT` row per searchable product and one `PHARMACY` row per
 *    transacting-eligible pharmacy, each with a `searchTsv` full-text vector;
 *  - `search_offers`: every purchasable (product, branch) offer, with price and location.
 *
 * Every refresh re-reads the owning module through its exported search-source port, so it is
 * idempotent and order-independent: a duplicated or out-of-order event converges on the same
 * rows. It never reads another module's tables (ADR-002), and the projection is never
 * authoritative: checkout re-verifies everything (Modules 05 and 06).
 */
@Injectable()
export class SearchProjectorService {
  private readonly logger = new AppLogger();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CATALOG_SEARCH_SOURCE_PORT) private readonly catalog: ICatalogSearchSourcePort,
    @Inject(PHARMACY_SEARCH_SOURCE_PORT) private readonly pharmacies: IPharmacySearchSourcePort,
  ) {
    this.logger.setContext(SearchProjectorService.name);
  }

  /** Product identity changed (created, updated, classified, status). Refreshes its offers too. */
  async refreshProduct(productId: string): Promise<'INDEXED' | 'REMOVED'> {
    const source = await this.catalog.product(productId);
    if (!source || !source.searchable || source.onlineSaleProhibited) {
      await this.prisma.$transaction([
        this.prisma.searchOffer.deleteMany({ where: { productId } }),
        this.prisma.searchDocument.deleteMany({ where: { entityType: 'PRODUCT', entityId: productId } }),
      ]);
      return 'REMOVED';
    }
    const attributes = {
      type: source.type,
      rxClassification: source.rxClassification,
      controlledSchedule: source.controlledSchedule,
      nameEn: source.nameEn,
      nameAm: source.nameAm,
      genericName: source.genericName,
      brandName: source.brandName,
      manufacturer: source.manufacturer,
      dosageForm: source.dosageForm,
      strength: source.strength,
      categories: source.categories,
    } as unknown as Prisma.InputJsonValue;
    const data = {
      title: source.nameEn ?? source.genericName ?? source.brandName ?? source.nameAm ?? '',
      subtitle: source.nameAm,
      description: source.genericName,
      keywords: [source.genericName, source.brandName, source.manufacturer].filter((v): v is string => Boolean(v)),
      categories: source.categories.map((c) => c.categoryId),
      attributes,
      status: 'ACTIVE' as const,
    };
    const doc = await this.prisma.searchDocument.upsert({
      where: { entityType_entityId_locale: { entityType: 'PRODUCT', entityId: productId, locale: LOCALE } },
      create: { entityType: 'PRODUCT', entityId: productId, locale: LOCALE, ...data },
      update: data,
      select: { id: true },
    });
    await this.setVector(doc.id, productSearchText(source));
    await this.refreshOffers(productId);
    return 'INDEXED';
  }

  /** A listing, its price or its stock changed: rebuild the product's purchasable offers. */
  async refreshOffers(productId: string): Promise<number> {
    const offers = await this.pharmacies.offersForProduct(productId);
    const doc = await this.prisma.searchDocument.findUnique({
      where: { entityType_entityId_locale: { entityType: 'PRODUCT', entityId: productId, locale: LOCALE } },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.searchOffer.deleteMany({ where: { productId } }),
      ...(doc
        ? [
            this.prisma.searchOffer.createMany({
              data: offers.map((o) => ({
                productId,
                pharmacyId: o.pharmacyId,
                pharmacyName: o.pharmacyName,
                branchId: o.branchId,
                branchName: o.branchName,
                city: o.city,
                lat: o.lat,
                lng: o.lng,
                price: o.price,
                currency: o.currency,
                sellable: o.sellable,
              })),
              skipDuplicates: true,
            }),
            this.prisma.searchDocument.update({
              where: { id: doc.id },
              data: {
                isAvailable: offers.length > 0,
                price: offers.length > 0 ? Math.min(...offers.map((o) => o.price)) : null,
                currency: offers[0]?.currency ?? 'ETB',
              },
            }),
          ]
        : []),
    ]);
    return doc ? offers.length : 0;
  }

  async refreshListing(listingId: string): Promise<void> {
    const productId = await this.pharmacies.productOfListing(listingId);
    if (productId) await this.refreshOffers(productId);
  }

  /** A pharmacy was activated or suspended: its own document, then every product it lists. */
  async refreshPharmacy(pharmacyId: string, options: { withOffers?: boolean } = {}): Promise<'INDEXED' | 'REMOVED'> {
    const source = await this.pharmacies.pharmacy(pharmacyId);
    let outcome: 'INDEXED' | 'REMOVED';
    if (!source || !source.eligible) {
      await this.prisma.searchDocument.deleteMany({ where: { entityType: 'PHARMACY', entityId: pharmacyId } });
      outcome = 'REMOVED';
    } else {
      const first = source.branches.find((b) => b.lat !== null && b.lng !== null) ?? source.branches[0];
      const data = {
        title: source.name,
        description: source.description,
        city: first?.city ?? null,
        latitude: first?.lat ?? null,
        longitude: first?.lng ?? null,
        ratingAvg: source.ratingAvg,
        isAvailable: true,
        attributes: { branches: source.branches } as unknown as Prisma.InputJsonValue,
        status: 'ACTIVE' as const,
      };
      const doc = await this.prisma.searchDocument.upsert({
        where: { entityType_entityId_locale: { entityType: 'PHARMACY', entityId: pharmacyId, locale: LOCALE } },
        create: { entityType: 'PHARMACY', entityId: pharmacyId, locale: LOCALE, ...data },
        update: data,
        select: { id: true },
      });
      const text = [source.name, ...source.branches.flatMap((b) => [b.name, b.city])]
        .filter((v): v is string => Boolean(v))
        .join(' ')
        .toLowerCase();
      await this.setVector(doc.id, text);
      outcome = 'INDEXED';
    }
    if (options.withOffers !== false) {
      for (const productId of await this.pharmacies.productsOfPharmacy(pharmacyId)) await this.refreshOffers(productId);
    }
    return outcome;
  }

  /** Rebuilds everything from the source modules (bootstrap, recovery). Idempotent. */
  async reindexAll(): Promise<{ products: number; pharmacies: number; failures: number }> {
    const report = { products: 0, pharmacies: 0, failures: 0 };
    for (const pharmacyId of await this.pharmacies.pharmacyIds()) {
      try {
        if ((await this.refreshPharmacy(pharmacyId, { withOffers: false })) === 'INDEXED') report.pharmacies += 1;
      } catch (err) {
        report.failures += 1;
        this.logger.error({ message: 'Search reindex failed for a pharmacy', pharmacyId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const productId of await this.catalog.productIds()) {
      try {
        if ((await this.refreshProduct(productId)) === 'INDEXED') report.products += 1;
      } catch (err) {
        report.failures += 1;
        this.logger.error({ message: 'Search reindex failed for a product', productId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  async isEmpty(): Promise<boolean> {
    return (await this.prisma.searchDocument.count()) === 0;
  }

  private async setVector(documentId: string, text: string): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "search_documents" SET "searchTsv" = to_tsvector('simple', ${text}) WHERE "id" = ${documentId}`;
  }
}
