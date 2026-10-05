import {
  CatalogAdminProductPage,
  ICatalogAdminReadPort,
  ProductStatus,
  ProductType,
} from '../../catalog/application/ports/inbound/catalog-admin-read.port';
import { toCatalogReviewListResponse } from '../interface/dtos/catalog-review.response';
import {
  DEFAULT_CATALOG_REVIEW_PAGE_SIZE,
  ListCatalogReviewQuery,
  MAX_CATALOG_REVIEW_PAGE_SIZE,
} from './queries/list-catalog-review.query';

/**
 * Module 16 Work 09's application layer, with Module 03 behind a fake port. The claims here are
 * about what Module 16 adds — defaults, clamping, an allow-listed response — and nothing else;
 * what the rows are is Module 03's claim, made against PostgreSQL in
 * `test/admin/admin-catalog-review.e2e-spec.ts`.
 */
describe('Admin catalogue review (application)', () => {
  const created = new Date('2026-09-01T08:00:00.000Z');
  const page: CatalogAdminProductPage = {
    items: [
      {
        id: 'p-1',
        type: ProductType.MEDICINE,
        genericName: 'Paracetamol',
        brandName: null,
        nameAm: null,
        nameEn: 'Paracetamol 500 mg',
        dosageForm: 'TABLET',
        strengthValue: 500,
        strengthUnit: 'MG',
        rxClassification: 'OTC',
        controlledSchedule: 'NONE',
        onlineSaleProhibited: false,
        manufacturerName: 'EPHARM',
        price: 1_250,
        status: ProductStatus.DRAFT,
        allowedTransitions: [ProductStatus.ACTIVE],
        createdAt: created,
        updatedAt: created,
      },
    ],
    total: 1,
    page: 1,
    size: 20,
  };

  let port: { listProducts: jest.Mock };
  let query: ListCatalogReviewQuery;

  beforeEach(() => {
    port = { listProducts: jest.fn().mockResolvedValue(page) };
    query = new ListCatalogReviewQuery(port as unknown as ICatalogAdminReadPort);
  });

  it('defaults to DRAFT, page 1, the default size, and passes no other filter', async () => {
    await query.execute({});
    expect(port.listProducts).toHaveBeenCalledTimes(1);
    expect(port.listProducts).toHaveBeenCalledWith(
      { status: ProductStatus.DRAFT, type: undefined, q: undefined },
      1,
      DEFAULT_CATALOG_REVIEW_PAGE_SIZE,
    );
  });

  it('passes the caller’s status, type and q through unchanged', async () => {
    await query.execute({ status: ProductStatus.DELISTED, type: ProductType.HEALTH_PRODUCT, q: 'vit', page: 3, size: 5 });
    expect(port.listProducts).toHaveBeenCalledWith(
      { status: ProductStatus.DELISTED, type: ProductType.HEALTH_PRODUCT, q: 'vit' },
      3,
      5,
    );
  });

  it('clamps an oversized page and replaces a non-positive one', async () => {
    await query.execute({ page: 0, size: 10_000 });
    expect(port.listProducts).toHaveBeenCalledWith(expect.anything(), 1, MAX_CATALOG_REVIEW_PAGE_SIZE);
  });

  it('returns Module 03’s page as it came, and fails when Module 03 fails', async () => {
    await expect(query.execute({})).resolves.toBe(page);
    port.listProducts.mockRejectedValueOnce(new Error('db down'));
    await expect(query.execute({})).rejects.toThrow('db down');
  });

  it('maps rows field by field: ISO dates, a copied transition list, nothing extra', () => {
    const row = { ...page.items[0], createdBy: 'user-secret', descriptionEn: 'long text' };
    const res = toCatalogReviewListResponse({ ...page, items: [row] });
    expect(res).toEqual({
      items: [
        {
          ...page.items[0],
          allowedTransitions: ['ACTIVE'],
          createdAt: '2026-09-01T08:00:00.000Z',
          updatedAt: '2026-09-01T08:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      size: 20,
    });
    expect(res.items[0]).not.toHaveProperty('createdBy');
    expect(res.items[0]).not.toHaveProperty('descriptionEn');
    expect(res.items[0].allowedTransitions).not.toBe(row.allowedTransitions);
  });
});
