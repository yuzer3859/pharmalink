import { Inject, Injectable } from '@nestjs/common';
import { CatalogErrors } from '../../domain/errors';
import { ProductStatus } from '../../domain/enums';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { PRODUCT_REPOSITORY, IProductRepository } from '../../domain/repositories/product.repository';
import { CategorySummary, ProductDetailView, toProductDetailView } from './product-view';

/** Statuses visible to non-admin callers via `GET /catalog/products/:id` (module-03 §8.1):
 * `DEPRECATED` stays visible read-only since existing orders/history may reference it, but is
 * excluded from `GET /catalog/products` search results. */
const PUBLICLY_VISIBLE_STATUSES: ReadonlySet<ProductStatus> = new Set([
  ProductStatus.ACTIVE,
  ProductStatus.DEPRECATED,
]);

/**
 * `GET /catalog/products/:id` (public, no permission required — §7.2/§8.1). Never leaks the
 * existence of a `DRAFT`/`PENDING_REVIEW`/`DELISTED` product to an unauthenticated caller
 * (§11 edge case 10). `admin = true` bypasses the visibility filter for `/admin/catalog/*`.
 */
@Injectable()
export class GetProductQuery {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
  ) {}

  async execute(id: string, admin = false): Promise<ProductDetailView> {
    const product = await this.products.findById(id);
    if (!product || product.deletedAt) {
      throw CatalogErrors.notFound();
    }
    if (!admin && !PUBLICLY_VISIBLE_STATUSES.has(product.status)) {
      throw CatalogErrors.notFound();
    }

    const categoryIds = await this.products.categoryIdsFor(product.id);
    const categoryEntities = await this.categories.findManyByIds(categoryIds);
    const categorySummaries: CategorySummary[] = categoryEntities.map((c) => {
      const props = c.toProps();
      return { id: props.id, slug: props.slug, nameAm: props.nameAm, nameEn: props.nameEn };
    });

    return toProductDetailView(product, categorySummaries);
  }
}
