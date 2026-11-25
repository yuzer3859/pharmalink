import { Injectable, Logger } from '@nestjs/common';
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

/** Work 158: how close a misspelt query must be to a document's text (pg_trgm `word_similarity`). */
export const SIMILARITY_THRESHOLD = 0.4;
export const MAX_SUGGESTIONS = 10;
/** Popular searches: how many times, over how long, before a query is offered to others. */
export const POPULAR_MIN_SEARCHES = 2;
export const SUGGEST_POPULAR_DAYS = 30;
export const TRENDING_DAYS = 7;

/**
 * Work 158: the query as plain words: letters and digits only (any script), lower-cased, single
 * spaces, at most 8 words. Used for typo matching and for counting popular searches, so the
 * same search typed differently counts once. `null` when nothing searchable remains.
 */
export function normalizeQuery(q: string | undefined | null): string | null {
  const tokens = (q ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = tokens.slice(0, MAX_SEARCH_TOKENS);
  return kept.length > 0 ? kept.join(' ') : null;
}

/** How a text query matched: its words as typed (`EXACT`), or close spellings (`SIMILAR`). */
export type MatchMode = 'EXACT' | 'SIMILAR';

interface TextMatch {
  mode: MatchMode;
  where: Prisma.Sql;
  score: Prisma.Sql;
}

function exactMatch(tsq: string): TextMatch {
  return {
    mode: 'EXACT',
    where: Prisma.sql`d."searchTsv" @@ to_tsquery('simple', ${tsq})`,
    score: Prisma.sql`ts_rank(d."searchTsv", to_tsquery('simple', ${tsq}))`,
  };
}

function similarMatch(normalized: string): TextMatch {
  return {
    mode: 'SIMILAR',
    where: Prisma.sql`word_similarity(${normalized}, d."searchText") >= ${SIMILARITY_THRESHOLD}`,
    score: Prisma.sql`word_similarity(${normalized}, d."searchText")`,
  };
}

export interface Suggestion {
  /** `QUERY` is a popular search; the others open that product or pharmacy. */
  kind: 'QUERY' | 'PRODUCT' | 'PHARMACY';
  text: string;
  id: string | null;
  subtitle: string | null;
  imageUrl: string | null;
}

export interface TrendingTerm {
  term: string;
  searches: number;
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
  /** Work 145: the product's main image, or `null`. */
  imageUrl: string | null;
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

/** Work 158: a text search's page, saying whether the words matched as typed or as close spellings. */
export interface SearchPage<T> extends Page<T> {
  /** `null` without query text. */
  match: MatchMode | null;
  /** With `SIMILAR`: the name the closest result goes by, to show as "Showing results for …". */
  didYouMean: string | null;
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
  private readonly logger = new Logger(SearchQueryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Work 158: the words as typed first; when they match nothing, close spellings
   * (`word_similarity` over the trigram-indexed text), ranked by closeness.
   */
  async medicines(input: MedicineSearchInput): Promise<SearchPage<MedicineHit>> {
    const started = Date.now();
    const tsq = toPrefixTsQuery(input.q);
    const normalized = normalizeQuery(input.q);
    let match: TextMatch | null = tsq ? exactMatch(tsq) : null;
    let page = await this.medicinesMatching(input, match);
    if (match && page.total === 0 && normalized) {
      match = similarMatch(normalized);
      page = await this.medicinesMatching(input, match);
    }
    await this.logQuery('PRODUCT', input.page, normalized, input.q, page.total, started);
    const best = match?.mode === 'SIMILAR' ? page.items[0] : undefined;
    return {
      items: page.items,
      total: page.total,
      page: input.page,
      size: input.size,
      match: match?.mode ?? null,
      didYouMean: best ? (best.nameEn ?? best.genericName ?? best.brandName ?? best.nameAm) : null,
    };
  }

  private async medicinesMatching(input: MedicineSearchInput, match: TextMatch | null): Promise<{ items: MedicineHit[]; total: number }> {
    const where: Prisma.Sql[] = [Prisma.sql`d."entityType" = 'PRODUCT'`, Prisma.sql`d."status" = 'ACTIVE'`];
    if (match) where.push(match.where);
    if (input.categoryId) where.push(Prisma.sql`${input.categoryId} = ANY(d."categories")`);
    if (input.rx) where.push(Prisma.sql`d."attributes"->>'rxClassification' = ${input.rx}`);

    const geo = input.geo;
    const offerFilter = geo
      ? Prisma.sql`AND o."lat" IS NOT NULL AND o."lng" IS NOT NULL AND ${distanceSql(Prisma.sql`o."lat"`, Prisma.sql`o."lng"`, geo)} <= ${geo.radiusKm * 1000}`
      : Prisma.empty;
    const nearest = geo ? Prisma.sql`MIN(${distanceSql(Prisma.sql`o."lat"`, Prisma.sql`o."lng"`, geo)})` : Prisma.sql`NULL::double precision`;
    // As typed: purchasable first, then relevance. Close spellings: the closest first.
    // Without text there is no relevance to order by. (A bare `0` would be read as a column position.)
    const order = !match
      ? Prisma.sql`(a."pharmacyCount" > 0) DESC, d."title" ASC`
      : match.mode === 'EXACT'
        ? Prisma.sql`(a."pharmacyCount" > 0) DESC, ${match.score} DESC, d."title" ASC`
        : Prisma.sql`${match.score} DESC, (a."pharmacyCount" > 0) DESC, d."title" ASC`;
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
      ORDER BY ${order}
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
          imageUrl: str('imageUrl'),
          availability: {
            pharmacyCount: r.pharmacyCount ?? 0,
            minPrice: r.minPrice ?? null,
            currency: r.currency ?? 'ETB',
            nearestDistanceMeters: r.nearest === null || r.nearest === undefined ? null : Math.round(r.nearest),
          },
        };
      }),
      total,
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

  /** Work 158: like medicines, the name as typed first, then close spellings. */
  async pharmacies(input: { q?: string; geo?: GeoFilter; page: number; size: number }): Promise<SearchPage<PharmacyHit>> {
    const started = Date.now();
    const tsq = toPrefixTsQuery(input.q);
    const normalized = normalizeQuery(input.q);
    let match: TextMatch | null = tsq ? exactMatch(tsq) : null;
    let page = await this.pharmaciesMatching(input, match);
    if (match && page.total === 0 && normalized) {
      match = similarMatch(normalized);
      page = await this.pharmaciesMatching(input, match);
    }
    await this.logQuery('PHARMACY', input.page, normalized, input.q, page.total, started);
    return {
      items: page.items,
      total: page.total,
      page: input.page,
      size: input.size,
      match: match?.mode ?? null,
      didYouMean: match?.mode === 'SIMILAR' ? (page.items[0]?.name ?? null) : null,
    };
  }

  private async pharmaciesMatching(
    input: { geo?: GeoFilter; page: number; size: number },
    match: TextMatch | null,
  ): Promise<{ items: PharmacyHit[]; total: number }> {
    const where: Prisma.Sql[] = [Prisma.sql`d."entityType" = 'PHARMACY'`, Prisma.sql`d."status" = 'ACTIVE'`];
    if (match) where.push(match.where);
    const dist = input.geo ? distanceSql(Prisma.sql`d."latitude"`, Prisma.sql`d."longitude"`, input.geo) : Prisma.sql`NULL::double precision`;
    if (input.geo) where.push(Prisma.sql`d."latitude" IS NOT NULL AND ${dist} <= ${input.geo.radiusKm * 1000}`);
    const whereSql = Prisma.join(where, ' AND ');
    const byScore = match ? Prisma.sql`${match.score} DESC,` : Prisma.empty;
    // Names as typed go nearest first with a location; close spellings rank by closeness.
    const order =
      input.geo && match?.mode !== 'SIMILAR' ? Prisma.sql`ORDER BY ${dist} ASC, d."title" ASC` : Prisma.sql`ORDER BY ${byScore} d."title" ASC`;
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
    };
  }

  /**
   * Work 158 (F-SR-11): what to offer while the customer types. Popular searches that start with
   * the words so far (searched at least twice in 30 days, and found something), then products
   * and pharmacies whose names start with them or are spelt close to them.
   */
  async suggest(q: string, limit: number): Promise<Suggestion[]> {
    const normalized = normalizeQuery(q);
    const tsq = toPrefixTsQuery(q);
    if (!normalized || !tsq) return [];
    const max = Math.min(Math.max(limit, 1), MAX_SUGGESTIONS);

    // The normalised text holds only letters, digits and spaces, so it is safe inside LIKE.
    const popular = await this.prisma.$queryRaw<Array<{ text: string }>>(Prisma.sql`
      SELECT l."normalized" AS text
      FROM "search_query_log" l
      WHERE l."normalized" LIKE ${normalized + '%'} AND l."normalized" <> ${normalized}
        AND l."resultCount" > 0 AND l."createdAt" > now() - (${SUGGEST_POPULAR_DAYS}::int * interval '1 day')
      GROUP BY l."normalized"
      HAVING COUNT(*) >= ${POPULAR_MIN_SEARCHES}
      ORDER BY COUNT(*) DESC, l."normalized" ASC
      LIMIT ${Math.min(3, max)}`);

    const docs = await this.prisma.$queryRaw<
      Array<{ entityType: 'PRODUCT' | 'PHARMACY'; entityId: string; title: string; subtitle: string | null; imageUrl: string | null }>
    >(Prisma.sql`
      SELECT d."entityType"::text AS "entityType", d."entityId", d."title", d."subtitle", d."attributes"->>'imageUrl' AS "imageUrl"
      FROM "search_documents" d
      WHERE d."status" = 'ACTIVE' AND d."entityType" IN ('PRODUCT', 'PHARMACY')
        AND (d."searchTsv" @@ to_tsquery('simple', ${tsq}) OR word_similarity(${normalized}, d."searchText") >= ${SIMILARITY_THRESHOLD})
      ORDER BY (d."searchTsv" @@ to_tsquery('simple', ${tsq})) DESC, word_similarity(${normalized}, d."searchText") DESC,
        d."entityType" ASC, d."title" ASC
      LIMIT ${max}`);

    const suggestions: Suggestion[] = popular.map((p) => ({ kind: 'QUERY', text: p.text, id: null, subtitle: null, imageUrl: null }));
    for (const d of docs) {
      suggestions.push({ kind: d.entityType, text: d.title, id: d.entityId, subtitle: d.subtitle, imageUrl: d.imageUrl });
    }
    return suggestions.slice(0, max);
  }

  /** Work 158 (F-SR-14): the searches most made over the last 7 days that found something. */
  async trending(limit: number): Promise<TrendingTerm[]> {
    return this.prisma.$queryRaw<TrendingTerm[]>(Prisma.sql`
      SELECT l."normalized" AS term, COUNT(*)::int AS searches
      FROM "search_query_log" l
      WHERE l."normalized" IS NOT NULL AND l."resultCount" > 0
        AND l."createdAt" > now() - (${TRENDING_DAYS}::int * interval '1 day')
      GROUP BY l."normalized"
      HAVING COUNT(*) >= ${POPULAR_MIN_SEARCHES}
      ORDER BY COUNT(*) DESC, l."normalized" ASC
      LIMIT ${limit}`);
  }

  /**
   * Work 158: one row per first-page text search, for popular searches and trending. Nothing
   * that identifies the person is kept. A failure here never fails the search.
   */
  private async logQuery(
    entityType: 'PRODUCT' | 'PHARMACY',
    page: number,
    normalized: string | null,
    raw: string | undefined,
    resultCount: number,
    started: number,
  ): Promise<void> {
    if (!normalized || page !== 1) return;
    try {
      await this.prisma.searchQueryLog.create({
        data: { rawQuery: (raw ?? '').trim().slice(0, 120), normalized, entityType, resultCount, latencyMs: Date.now() - started },
      });
    } catch (err) {
      this.logger.warn({ message: 'Search query log write failed', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
