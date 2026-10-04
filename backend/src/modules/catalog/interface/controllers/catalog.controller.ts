import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../../identity/interface/decorators/public.decorator';
import { GetCategoryTreeQuery } from '../../application/queries/get-category-tree.query';
import { GetProductQuery } from '../../application/queries/get-product.query';
import { ListProductsByCategoryQuery } from '../../application/queries/list-products-by-category.query';
import { SearchProductsQuery } from '../../application/queries/search-products.query';
import { SearchProductsQueryDto } from '../dtos/product.dto';

/**
 * Public Catalog reads (module-03 §7.2/§8.1). Every handler is a bare `@Public()` and nothing
 * else — resolved by Architect review (§14.1) against the actual `JwtAuthGuard`/`PermissionsGuard`
 * implementations, the identical pattern already used by `auth.controller.ts`. No permission is
 * ever attached to these routes (`catalog:read:any` stays reserved and unused, §7.1).
 */
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly searchProducts: SearchProductsQuery,
    private readonly getProduct: GetProductQuery,
    private readonly getCategoryTree: GetCategoryTreeQuery,
    private readonly listProductsByCategory: ListProductsByCategoryQuery,
  ) {}

  @Get('products')
  @Public()
  list(@Query() query: SearchProductsQueryDto) {
    return this.searchProducts.execute({
      q: query.q,
      type: query.type,
      categoryId: query.categoryId,
      rx: query.rx,
      manufacturerId: query.manufacturerId,
      sort: query.sort,
      page: query.page ?? 1,
      size: query.size ?? 20,
    });
  }

  @Get('products/:id')
  @Public()
  get(@Param('id') id: string) {
    return this.getProduct.execute(id, false);
  }

  @Get('categories')
  @Public()
  categoryTree() {
    return this.getCategoryTree.execute();
  }

  @Get('categories/:id/products')
  @Public()
  productsByCategory(
    @Param('id') id: string,
    @Query() query: SearchProductsQueryDto,
  ) {
    return this.listProductsByCategory.execute(id, query.page ?? 1, query.size ?? 20);
  }
}
