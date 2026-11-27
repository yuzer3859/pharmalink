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
import {
  IProviderSearchSourcePort,
  PROVIDER_SEARCH_SOURCE_PORT,
} from '../../provider-directory/application/ports/inbound/provider-search-source.port';
import { DOCTOR_SEARCH_SOURCE_PORT, IDoctorSearchSourcePort } from '../../doctors/application/ports/inbound/doctor-search-source.port';

const LOCALE = 'en';

/** Work 162: words a provider type is found by, in English and Amharic. */
const PROVIDER_TYPE_WORDS: Record<string, string> = {
  HOSPITAL: 'hospital ሆስፒታል',
  CLINIC: 'clinic ክሊኒክ',
  DIAGNOSTIC_CENTER: 'diagnostic center centre imaging ምርመራ',
  LAB: 'lab laboratory ላብራቶሪ',
};

/** Work 162: words a service type is found by. */
const SERVICE_TYPE_WORDS: Record<string, string> = {
  LAB_TEST: 'lab test laboratory ምርመራ',
  IMAGING: 'imaging scan radiology',
  SCREENING_PACKAGE: 'screening package checkup check-up',
};

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
    @Inject(PROVIDER_SEARCH_SOURCE_PORT) private readonly providers: IProviderSearchSourcePort,
    @Inject(DOCTOR_SEARCH_SOURCE_PORT) private readonly doctors: IDoctorSearchSourcePort,
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
      imageUrl: source.imageUrl,
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

  /**
   * Work 162: a healthcare provider changed (activated, suspended, profile, locations,
   * departments or services). One `PROVIDER` document for the provider, at its primary location,
   * and one `DIAGNOSTIC_SERVICE` document per available service — or none of them when it is not
   * eligible. Rebuilt whole from Module 09 each time.
   */
  async refreshProvider(providerId: string): Promise<'INDEXED' | 'REMOVED'> {
    const source = await this.providers.provider(providerId);
    const serviceDocs = { entityType: 'DIAGNOSTIC_SERVICE' as const, attributes: { path: ['providerId'], equals: providerId } };
    if (!source || !source.eligible) {
      await this.prisma.$transaction([
        this.prisma.searchDocument.deleteMany({ where: serviceDocs }),
        this.prisma.searchDocument.deleteMany({ where: { entityType: 'PROVIDER', entityId: providerId } }),
      ]);
      return 'REMOVED';
    }

    const located = source.locations.filter((l) => l.lat !== null && l.lng !== null);
    const primary = located.find((l) => l.isPrimary) ?? located[0] ?? source.locations[0];
    const emergency = source.locations.some((l) => l.emergencyAvailability === 'H24_7')
      ? 'H24_7'
      : source.locations.some((l) => l.emergencyAvailability === 'BUSINESS_HOURS')
        ? 'BUSINESS_HOURS'
        : 'NONE';
    const specialties = [...new Set(source.departments.map((d) => d.specialty ?? d.name).filter((v): v is string => Boolean(v)))].sort();
    const serviceTypes = [...new Set(source.services.map((s) => s.type))].sort();
    const cities = [...new Set(source.locations.map((l) => l.city).filter((v): v is string => Boolean(v)))];
    const data = {
      title: source.displayName,
      subtitle: source.nameAm,
      description: source.description,
      keywords: [...specialties, ...source.departments.map((d) => d.name), ...source.services.map((s) => s.name)].slice(0, 200),
      categories: [source.type],
      city: primary?.city ?? null,
      latitude: primary?.lat ?? null,
      longitude: primary?.lng ?? null,
      ratingAvg: source.ratingCount > 0 ? source.ratingAvg : null,
      isAvailable: true,
      attributes: {
        type: source.type,
        nameAm: source.nameAm,
        emergency,
        specialties,
        serviceTypes,
        cities,
        locationCount: source.locations.length,
        serviceCount: source.services.length,
        ratingCount: source.ratingCount,
      } as unknown as Prisma.InputJsonValue,
      status: 'ACTIVE' as const,
    };
    const doc = await this.prisma.searchDocument.upsert({
      where: { entityType_entityId_locale: { entityType: 'PROVIDER', entityId: providerId, locale: LOCALE } },
      create: { entityType: 'PROVIDER', entityId: providerId, locale: LOCALE, ...data },
      update: data,
      select: { id: true },
    });
    await this.setVector(
      doc.id,
      [
        source.displayName,
        source.nameAm,
        PROVIDER_TYPE_WORDS[source.type] ?? '',
        ...cities,
        ...source.locations.map((l) => l.subcity),
        ...specialties,
        ...source.departments.map((d) => d.name),
        ...source.services.map((s) => s.name),
      ]
        .filter((v): v is string => Boolean(v && v.trim()))
        .join(' ')
        .toLowerCase(),
    );

    // The provider's services: a removed or unavailable one disappears; the rest are upserted, so a
    // concurrent refresh of the same provider converges instead of colliding.
    await this.prisma.searchDocument.deleteMany({ where: { ...serviceDocs, entityId: { notIn: source.services.map((x) => x.serviceId) } } });
    for (const s of source.services) {
      const at = (s.locationId ? located.find((l) => l.locationId === s.locationId) : undefined) ?? primary;
      const serviceData = {
        title: s.name,
        subtitle: source.displayName,
        description: s.preparationInstructions,
        keywords: [s.code, s.type].filter((v): v is string => Boolean(v)),
        categories: [s.type],
        city: at?.city ?? null,
        latitude: at?.lat ?? null,
        longitude: at?.lng ?? null,
        price: s.price,
        currency: s.currency,
        ratingAvg: data.ratingAvg,
        isAvailable: true,
        attributes: {
          providerId,
          providerName: source.displayName,
          providerType: source.type,
          serviceType: s.type,
          code: s.code,
          durationMinutes: s.durationMinutes,
          preparationInstructions: s.preparationInstructions,
          locationId: at?.locationId ?? null,
          locationName: at?.name ?? null,
        } as unknown as Prisma.InputJsonValue,
        status: 'ACTIVE' as const,
      };
      const service = await this.prisma.searchDocument.upsert({
        where: { entityType_entityId_locale: { entityType: 'DIAGNOSTIC_SERVICE', entityId: s.serviceId, locale: LOCALE } },
        create: { entityType: 'DIAGNOSTIC_SERVICE', entityId: s.serviceId, locale: LOCALE, ...serviceData },
        update: serviceData,
        select: { id: true },
      });
      await this.setVector(
        service.id,
        [s.name, s.code, SERVICE_TYPE_WORDS[s.type] ?? '', source.displayName, at?.city]
          .filter((v): v is string => Boolean(v && v.trim()))
          .join(' ')
          .toLowerCase(),
      );
    }
    return 'INDEXED';
  }

  /**
   * Work 167: a doctor changed (registered, suspended, profile, where they practise, or their
   * slots). One `DOCTOR` document per listed doctor, at their primary facility's main location,
   * with the next open slot; none when the doctor is not listed.
   */
  async refreshDoctor(doctorId: string): Promise<'INDEXED' | 'REMOVED'> {
    const source = await this.doctors.doctor(doctorId);
    if (!source || !source.listed) {
      await this.prisma.searchDocument.deleteMany({ where: { entityType: 'DOCTOR', entityId: doctorId } });
      return 'REMOVED';
    }
    const at = source.practices.find((p) => p.lat !== null && p.lng !== null) ?? source.practices[0];
    const fee = source.consultationFeeInPerson ?? source.consultationFeeTele;
    const data = {
      title: source.fullName,
      subtitle: source.fullNameAm,
      description: source.specialty,
      keywords: [source.specialty, ...source.subSpecialties, ...source.practices.map((p) => p.providerName), ...source.languages].filter((v): v is string => Boolean(v)).slice(0, 100),
      categories: source.specialty ? [source.specialty] : [],
      city: at?.city ?? null,
      latitude: at?.lat ?? null,
      longitude: at?.lng ?? null,
      price: fee,
      currency: source.currency,
      ratingAvg: source.ratingCount > 0 ? source.ratingAvg : null,
      isAvailable: source.nextAvailableAt !== null,
      attributes: {
        fullNameAm: source.fullNameAm,
        specialty: source.specialty,
        subSpecialties: source.subSpecialties,
        languages: source.languages,
        acceptsTelemedicine: source.acceptsTelemedicine,
        feeInPerson: source.consultationFeeInPerson,
        feeTele: source.consultationFeeTele,
        practices: source.practices.map((p) => ({ providerId: p.providerId, name: p.providerName, city: p.city })),
        providerIds: source.practices.map((p) => p.providerId),
        nextAvailableAt: source.nextAvailableAt?.toISOString() ?? null,
        ratingCount: source.ratingCount,
      } as unknown as Prisma.InputJsonValue,
      status: 'ACTIVE' as const,
    };
    const doc = await this.prisma.searchDocument.upsert({
      where: { entityType_entityId_locale: { entityType: 'DOCTOR', entityId: doctorId, locale: LOCALE } },
      create: { entityType: 'DOCTOR', entityId: doctorId, locale: LOCALE, ...data },
      update: data,
      select: { id: true },
    });
    await this.setVector(
      doc.id,
      ['doctor dr ሐኪም ዶክተር', source.fullName, source.fullNameAm, source.specialty, ...source.subSpecialties, ...source.languages, ...source.practices.flatMap((p) => [p.providerName, p.departmentName, p.city])]
        .filter((v): v is string => Boolean(v && v.trim()))
        .join(' ')
        .toLowerCase(),
    );
    return 'INDEXED';
  }

  /** Work 167: the doctors practising at a facility, after the facility changed. */
  async refreshDoctorsAt(providerId: string): Promise<void> {
    for (const doctorId of await this.doctors.doctorIdsAt(providerId)) await this.refreshDoctor(doctorId);
  }

  /** Rebuilds everything from the source modules (bootstrap, recovery). Idempotent. */
  async reindexAll(): Promise<{ products: number; pharmacies: number; providers: number; doctors: number; failures: number }> {
    const report = { products: 0, pharmacies: 0, providers: 0, doctors: 0, failures: 0 };
    for (const doctorId of await this.doctors.doctorIds()) {
      try {
        if ((await this.refreshDoctor(doctorId)) === 'INDEXED') report.doctors += 1;
      } catch (err) {
        report.failures += 1;
        this.logger.error({ message: 'Search reindex failed for a doctor', doctorId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const providerId of await this.providers.providerIds()) {
      try {
        if ((await this.refreshProvider(providerId)) === 'INDEXED') report.providers += 1;
      } catch (err) {
        report.failures += 1;
        this.logger.error({ message: 'Search reindex failed for a healthcare provider', providerId, error: err instanceof Error ? err.message : String(err) });
      }
    }
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
    await this.prisma.$executeRaw`UPDATE "search_documents" SET "searchTsv" = to_tsvector('simple', ${text}), "searchText" = lower(${text}) WHERE "id" = ${documentId}`;
  }
}
