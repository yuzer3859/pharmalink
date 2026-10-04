import { Inject, Injectable } from '@nestjs/common';
import { ProductType } from '../../domain/enums';
import { PRODUCT_REPOSITORY, IProductRepository } from '../../domain/repositories/product.repository';
import { ProductSummaryView } from './product-view';

export interface SearchProductsInput {
  q?: string;
  type?: string;
  categoryId?: string;
  rx?: string;
  manufacturerId?: string;
  sort?: 'relevance' | 'name_asc' | 'newest';
  page: number;
  size: number;
}

export interface PagedResult<T> {
  items: T[];
  meta: { page: number; size: number; total: number };
}

/** `GET /catalog/products` (public, no permission required — §7.2/§8.1). Only ever returns
 * `status = ACTIVE`, `deletedAt IS NULL` products (§4.5), enforced in the query, not just the
 * controller (defense in depth). */
@Injectable()
export class SearchProductsQuery {
  constructor(@Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepository) {}

  async execute(input: SearchProductsInput): Promise<PagedResult<ProductSummaryView>> {
    const { items, total } = await this.products.search({
      q: input.q,
      type: input.type as ProductType | undefined,
      categoryId: input.categoryId,
      rx: input.rx,
      manufacturerId: input.manufacturerId,
      sort: input.sort ?? 'relevance',
      page: input.page,
      size: input.size,
    });
    return { items, meta: { page: input.page, size: input.size, total } };
  }
}
