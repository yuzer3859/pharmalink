import { Inject, Injectable } from '@nestjs/common';
import { CatalogErrors } from '../../domain/errors';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { PRODUCT_REPOSITORY, IProductRepository } from '../../domain/repositories/product.repository';
import { PagedResult } from './search-products.query';
import { ProductSummaryView } from './product-view';

/** `GET /catalog/categories/:id/products` (public, no permission required — §7.2/§8.1). Direct
 * assignments only, not recursive into subcategories (resolved by Architect review, §14.7). */
@Injectable()
export class ListProductsByCategoryQuery {
  constructor(
    @Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository,
  ) {}

  async execute(categoryId: string, page: number, size: number): Promise<PagedResult<ProductSummaryView>> {
    const category = await this.categories.findById(categoryId);
    if (!category || !category.isActive) {
      throw CatalogErrors.categoryNotFound();
    }
    const { items, total } = await this.products.listByCategory(categoryId, page, size);
    return { items, meta: { page, size, total } };
  }
}
