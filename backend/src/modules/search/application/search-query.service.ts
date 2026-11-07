import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';

export const MAX_SEARCH_TOKENS = 8;
export const DEFAULT_RADIUS_KM = 25;
export const MAX_RADIUS_KM = 200;

/**
 * Turns free text into a safe prefix `tsquery` for the 'simple' configuration: letters and digits
 * only (any script, so Amharic works), lower-cased, at most 8 tokens, each a prefix (`para:*`).
 * `null` when nothing searchable remains. Tokens are bound as one parameter, never interpolated.
 */
export function toPrefixTsQuery(q: string | undefined | null): string | null {
  const tokens = (q ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = tokens.slice(0, MAX_SEARCH_TOKENS);
  return kept.length > 0 ? kept.map((t) => `${t}:*`).join(' & ') : null;
}

export interface GeoFilter {
  lat: number;
  lng: number;
  radiusKm: number;
}

export interface MedicineSearchInput {
  q?: string;
  categoryId?: string;
  rx?: 'RX' | 'OTC';
  geo?: GeoFilter;
  availableOnly?: boolean;
  page: number;
  size: number;
}

export interface MedicineHit {
  productId: string;
  nameEn: string | null;
  nameAm: string | null;
  genericName: string | null;
  brandName: string | null;
  manufacturer: string | null;
  strength: string | null;
  dosageForm: string | null;
  rxClassification: string | null;
  categories: Array<{ categoryId: string; slug: string; nameEn: string | null; nameAm: string | null }>;
  availability: {
    pharmacyCount: number;
    minPrice: number | null;
    currency: string;
    /** Nearest purchasable branch, when a location was given. */
    nearestDistanceMeters: number | null;
  };
}

export interface OfferHit {
  pharmacyId: string;
  pharmacyName: string;
  branchId: string;
  branchName: string;
  city: string | null;
  price: number;
  currency: string;
  sellable: number;
  distanceMeters: number | null;
}

export interface PharmacyHit {
  pharmacyId: string;
  name: string;
  description: string | null;
  city: string | null;
  ratingAvg: number | null;
  distanceMeters: number | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** Great-circle distance in metres between a row's (lat, lng) columns and a point, in SQL. */
function distanceSql(latCol: Prisma.Sql, lngCol: Prisma.Sql, geo: GeoFilter): Prisma.Sql {
  return Prisma.sql`(6371000 * 2 * asin(sqrt(power(sin(radians(${latCol} - ${geo.lat}) / 2), 2) + cos(radians(${geo.lat})) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - ${geo.lng}) / 2), 2))))`;
}

/**
 * Work 98: Module 14's public read side over its own projections (module-14 §9, minimal):
 * medicines with their nearby availability, a product's purchasable pharmacies, and pharmacies.
 * Ranking: purchasable first (within the radius when a location is given), then text relevance,
 * then name. Eligibility is already applied by the projection.
 */
@Injectable()
export class SearchQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async medicines(input: MedicineSearchInput): Promise<Page<MedicineHit>> {
    const tsq = toPrefixTsQuery(input.q);
    const where: Prisma.Sql[] = [Prisma.sql`d."entityType" = 'PRODUCT'`, Prisma.sql`d."status" = 'ACTIVE'`];
    if (tsq) where.push(Prisma.sql`d."searchTsv" @@ to_tsquery('simple', ${tsq})`);
    if (input.categoryId) where.push(Prisma.sql`${input.categoryId} = ANY(d."categories")`);
    if (input.rx) where.push(Prisma.sql`d."attributes"->>'rxClassification' = ${input.rx}`);

    const geo = input.geo;
    const offerFilter = geo
      ? Prisma.sql`AND o."lat" IS NOT NULL AND o."lng" IS NOT NULL AND ${distanceSql(Prisma.sql`o."lat"`, Prisma.sql`o."lng"`, geo)} <= ${geo.radiusKm * 1000}`
      : Prisma.empty;
    const nearest = geo ? Prisma.sql`MIN(${distanceSql(Prisma.sql`o."lat"`, Prisma.sql`o."lng"`, geo)})` : Prisma.sql`NULL::double precision`;
    // Without text there is no relevance to order by. (A bare `0` would be read as a column position.)
    const byRank = tsq ? Prisma.sql`ts_rank(d."searchTsv", to_tsquery('simple', ${tsq})) DESC,` : Prisma.empty;
    const availability = Prisma.sql`
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT o."branchId")::int AS "pharmacyCount", MIN(o."price") AS "minPrice", ${nearest} AS "nearest"
        FROM "search_offers" o WHERE o."productId" = d."entityId" ${offerFilter}
      ) a ON true`;
    if (input.availableOnly) where.push(Prisma.sql`a."pharmacyCount" > 0`);
    const whereSql = Prisma.join(where, ' AND ');

    const offset = (input.page - 1) * input.size;
    const rows = await this.prisma.$queryRaw<
      Array<{ entityId: string; attributes: Record<string, unknown> | null; currency: string | null; pharmacyCount: number; minPrice: number | null; nearest: number | null }>
    >(Prisma.sql`
      SELECT d."entityId", d."attributes", d."currency", a."pharmacyCount", a."minPrice", a."nearest"
      FROM "search_documents" d ${availability}
      WHERE ${whereSql}
      ORDER BY (a."pharmacyCount" > 0) DESC, ${byRank} d."title" ASC
      LIMIT ${input.size} OFFSET ${offset}`);
    const [{ total }] = await this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total FROM "search_documents" d ${availability} WHERE ${whereSql}`);

    return {
      items: rows.map((r) => {
        const a = (r.attributes ?? {}) as Record<string, unknown>;
        const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : null);
        return {
          productId: r.entityId,
          nameEn: str('nameEn'),
          nameAm: str('nameAm'),
          genericName: str('genericName'),
          brandName: str('brandName'),
          manufacturer: str('manufacturer'),
          strength: str('strength'),
          dosageForm: str('dosageForm'),
          rxClassification: str('rxClassification'),
          categories: Array.isArray(a.categories) ? (a.categories as MedicineHit['categories']) : [],
          availability: {
            pharmacyCount: r.pharmacyCount ?? 0,
            minPrice: r.minPrice ?? null,
            currency: r.currency ?? 'ETB',
            nearestDistanceMeters: r.nearest === null || r.nearest === undefined ? null : Math.round(r.nearest),
          },
        };
      }),
      total,
      page: input.page,
      size: input.size,
    };
  }

  /** A product's purchasable pharmacies: nearest first with a location (within the radius), else cheapest. */
  async offers(productId: string, geo: GeoFilter | undefined, limit: number): Promise<OfferHit[]> {
    const dist = geo ? distanceSql(Prisma.sql`o."lat"`, Prisma.sql`o."lng"`, geo) : Prisma.sql`NULL::double precision`;
    const radius = geo
      ? Prisma.sql`AND o."lat" IS NOT NULL AND o."lng" IS NOT NULL AND ${dist} <= ${geo.radiusKm * 1000}`
      : Prisma.empty;
    const order = geo ? Prisma.sql`ORDER BY ${dist} ASC, o."price" ASC` : Prisma.sql`ORDER BY o."price" ASC, o."pharmacyName" ASC`;
    const rows = await this.prisma.$queryRaw<Array<OfferHit & { distanceMeters: number | null }>>(Prisma.sql`
      SELECT o."pharmacyId", o."pharmacyName", o."branchId", o."branchName", o."city", o."price", o."currency", o."sellable", ${dist} AS "distanceMeters"
      FROM "search_offers" o WHERE o."productId" = ${productId} ${radius} ${order} LIMIT ${limit}`);
    return rows.map((r) => ({ ...r, distanceMeters: r.distanceMeters === null ? null : Math.round(r.distanceMeters) }));
  }

  async pharmacies(input: { q?: string; geo?: GeoFilter; page: number; size: number }): Promise<Page<PharmacyHit>> {
    const tsq = toPrefixTsQuery(input.q);
    const where: Prisma.Sql[] = [Prisma.sql`d."entityType" = 'PHARMACY'`, Prisma.sql`d."status" = 'ACTIVE'`];
    if (tsq) where.push(Prisma.sql`d."searchTsv" @@ to_tsquery('simple', ${tsq})`);
    const dist = input.geo ? distanceSql(Prisma.sql`d."latitude"`, Prisma.sql`d."longitude"`, input.geo) : Prisma.sql`NULL::double precision`;
    if (input.geo) where.push(Prisma.sql`d."latitude" IS NOT NULL AND ${dist} <= ${input.geo.radiusKm * 1000}`);
    const whereSql = Prisma.join(where, ' AND ');
    const byRank = tsq ? Prisma.sql`ts_rank(d."searchTsv", to_tsquery('simple', ${tsq})) DESC,` : Prisma.empty;
    const order = input.geo ? Prisma.sql`ORDER BY ${dist} ASC, d."title" ASC` : Prisma.sql`ORDER BY ${byRank} d."title" ASC`;
    const offset = (input.page - 1) * input.size;
    const rows = await this.prisma.$queryRaw<
      Array<{ entityId: string; title: string; description: string | null; city: string | null; ratingAvg: number | null; distanceMeters: number | null }>
    >(Prisma.sql`
      SELECT d."entityId", d."title", d."description", d."city", d."ratingAvg", ${dist} AS "distanceMeters"
      FROM "search_documents" d WHERE ${whereSql} ${order} LIMIT ${input.size} OFFSET ${offset}`);
    const [{ total }] = await this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total FROM "search_documents" d WHERE ${whereSql}`);
    return {
      items: rows.map((r) => ({
        pharmacyId: r.entityId,
        name: r.title,
        description: r.description,
        city: r.city,
        ratingAvg: r.ratingAvg,
        distanceMeters: r.distanceMeters === null ? null : Math.round(r.distanceMeters),
      })),
      total,
      page: input.page,
      size: input.size,
    };
  }
}
