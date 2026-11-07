import request from 'supertest';
import { SearchProjectorService } from '../../src/modules/search/application/search-projector.service';
import { toPrefixTsQuery } from '../../src/modules/search/application/search-query.service';
import { body } from '../support/fixtures';
import { closeTestApp, createTestApp, TestContext } from '../support/test-app';
import { createPricedProduct, createStockedPharmacy } from '../orders/support';

/**
 * Work 98: Module 14 minimal search (Phase 1). Postgres full-text search over products and
 * pharmacies with nearby purchasable availability and price; Amharic and English names, Rx/OTC
 * and category filters, pagination; kept in sync by the outbox; a public read API.
 */
describe('Search — minimal Module 14 (Work 98, e2e)', () => {
  let ctx: TestContext;
  let projector: SearchProjectorService;

  beforeAll(async () => {
    ctx = await createTestApp();
    projector = ctx.app.get(SearchProjectorService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  const get = (path: string) => request(ctx.server).get(path);
  const items = async (path: string) => body(await get(path).expect(200)).items as Array<Record<string, unknown>>;

  /** An OTC "Ibuprofen 400mg" with an Amharic name, stocked by one pharmacy at (9.02, 38.75). */
  async function stockedProduct(kind: 'OTC' | 'RX' = 'OTC') {
    const productId = await createPricedProduct(ctx, { kind });
    await ctx.prisma.product.update({ where: { id: productId }, data: { nameAm: 'ኢቡፕሮፌን' } });
    const pharmacy = await createStockedPharmacy(ctx, productId, 20);
    return { productId, pharmacy };
  }

  it('is kept in sync by the outbox: a product published and stocked is found without a reindex', async () => {
    const { productId } = await stockedProduct();
    await ctx.drainOutbox();
    const hits = await items('/search/medicines?q=ibup');
    expect(hits.map((h) => h.productId)).toContain(productId);
  });

  it('finds a product by English and by Amharic name, with its purchasable availability', async () => {
    const { productId } = await stockedProduct();
    await projector.reindexAll();

    for (const q of ['ibu', 'Ibuprofen 400', encodeURIComponent('ኢቡ')]) {
      const hits = await items(`/search/medicines?q=${q}`);
      expect(hits).toEqual([
        expect.objectContaining({
          productId,
          nameEn: 'Ibuprofen 400mg',
          nameAm: 'ኢቡፕሮፌን',
          genericName: 'Ibuprofen',
          rxClassification: 'OTC',
          availability: { pharmacyCount: 1, minPrice: 2500, currency: 'ETB', nearestDistanceMeters: null },
        }),
      ]);
    }
    expect(await items('/search/medicines?q=paracetamol')).toEqual([]);
  });

  it('filters by Rx/OTC and category, and pages', async () => {
    const otc = await stockedProduct('OTC');
    const rx = await stockedProduct('RX');
    await projector.reindexAll();

    expect((await items('/search/medicines?rx=RX')).map((h) => h.productId)).toEqual([rx.productId]);
    expect((await items('/search/medicines?rx=OTC')).map((h) => h.productId)).toEqual([otc.productId]);

    const category = await ctx.prisma.category.create({ data: { slug: `pain-${Date.now()}`, nameEn: 'Pain relief', nameAm: 'ህመም' } });
    await ctx.prisma.productCategory.create({ data: { productId: otc.productId, categoryId: category.id } });
    await projector.refreshProduct(otc.productId);
    expect((await items(`/search/medicines?categoryId=${category.id}`)).map((h) => h.productId)).toEqual([otc.productId]);
    expect((await items('/search/medicines?q=pain')).map((h) => h.productId)).toEqual([otc.productId]);

    const page1 = body(await get('/search/medicines?size=1&page=1').expect(200));
    const page2 = body(await get('/search/medicines?size=1&page=2').expect(200));
    expect(page1).toMatchObject({ total: 2, page: 1, size: 1 });
    expect((page1.items as unknown[]).length).toBe(1);
    expect((page2.items as Array<{ productId: string }>)[0].productId).not.toBe((page1.items as Array<{ productId: string }>)[0].productId);
  });

  it('with a location: nearest distance within the radius, and availableOnly drops products out of reach', async () => {
    const { productId } = await stockedProduct();
    await projector.reindexAll();

    const near = await items('/search/medicines?q=ibu&lat=9.03&lng=38.75&radiusKm=5');
    expect((near[0].availability as { nearestDistanceMeters: number }).nearestDistanceMeters).toBeGreaterThan(500);
    expect((near[0].availability as { nearestDistanceMeters: number }).nearestDistanceMeters).toBeLessThan(2_000);

    const far = await items('/search/medicines?q=ibu&lat=13.5&lng=39.47&radiusKm=10');
    expect(far[0]).toMatchObject({ productId, availability: { pharmacyCount: 0, minPrice: null } });
    expect(await items('/search/medicines?q=ibu&lat=13.5&lng=39.47&radiusKm=10&availableOnly=true')).toEqual([]);
  });

  it('lists where a product can be bought: pharmacy, branch, price and distance', async () => {
    const { productId, pharmacy } = await stockedProduct();
    await projector.reindexAll();
    const offers = await items(`/search/medicines/${productId}/pharmacies?lat=9.02&lng=38.75`);
    expect(offers).toEqual([
      expect.objectContaining({ pharmacyId: pharmacy.pharmacyId, branchId: pharmacy.branchId, branchName: 'Main Branch', price: 2500, sellable: 20, distanceMeters: 0 }),
    ]);
  });

  it('a suspended pharmacy disappears from search and from availability', async () => {
    const { productId, pharmacy } = await stockedProduct();
    await projector.reindexAll();
    const name = (await ctx.prisma.pharmacy.findUniqueOrThrow({ where: { id: pharmacy.pharmacyId } })).displayName;
    expect((await items(`/search/pharmacies?q=${encodeURIComponent(name)}`)).map((h) => h.pharmacyId)).toEqual([pharmacy.pharmacyId]);

    await ctx.prisma.pharmacy.update({ where: { id: pharmacy.pharmacyId }, data: { transactingStatus: 'SUSPENDED' } });
    await projector.refreshPharmacy(pharmacy.pharmacyId);

    expect(await items(`/search/pharmacies?q=${encodeURIComponent(name)}`)).toEqual([]);
    expect(await items(`/search/medicines/${productId}/pharmacies`)).toEqual([]);
    expect((await items('/search/medicines?q=ibu'))[0]).toMatchObject({ availability: { pharmacyCount: 0 } });
  });

  it('a product taken off sale leaves the index', async () => {
    const { productId } = await stockedProduct();
    await projector.reindexAll();
    await ctx.prisma.product.update({ where: { id: productId }, data: { status: 'DELISTED' } });
    expect(await projector.refreshProduct(productId)).toBe('REMOVED');
    expect(await items('/search/medicines?q=ibu')).toEqual([]);
  });

  it('needs no sign-in, refuses half a location, and treats query text as text', async () => {
    await stockedProduct();
    await projector.reindexAll();
    await get('/search/medicines?lat=9.02').expect(400);
    await get('/search/medicines?rx=CONTROLLED').expect(400);
    expect(await items(`/search/medicines?q=${encodeURIComponent("ibu'); DROP TABLE search_documents; --")}`)).toEqual(expect.any(Array));
    expect(await ctx.prisma.searchDocument.count()).toBeGreaterThan(0);
  });

  it('builds safe prefix queries', () => {
    expect(toPrefixTsQuery('Ibuprofen 400mg')).toBe('ibuprofen:* & 400mg:*');
    expect(toPrefixTsQuery("a'b & | ! ( ) :*")).toBe('a:* & b:*');
    expect(toPrefixTsQuery('ኢቡ ፕሮ')).toBe('ኢቡ:* & ፕሮ:*');
    expect(toPrefixTsQuery('   ')).toBeNull();
  });
});
