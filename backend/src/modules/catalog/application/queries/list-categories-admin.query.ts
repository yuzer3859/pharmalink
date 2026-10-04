import { Inject, Injectable } from '@nestjs/common';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { CategoryView, toCategoryView } from './category-view';

/** `GET /admin/catalog/categories` (`catalog:manage:any`) — admin variant returns inactive
 * categories too (§8.2), as a flat list (the tree shape is a public-read convenience, §8.1). */
@Injectable()
export class ListCategoriesAdminQuery {
  constructor(@Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository) {}

  async execute(): Promise<CategoryView[]> {
    const categories = await this.categories.listAll();
    return categories.map(toCategoryView);
  }
}
