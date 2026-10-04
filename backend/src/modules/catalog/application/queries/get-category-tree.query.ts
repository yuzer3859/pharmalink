import { Inject, Injectable } from '@nestjs/common';
import { CATEGORY_REPOSITORY, ICategoryRepository } from '../../domain/repositories/category.repository';
import { buildCategoryTree, CategoryTreeNode } from './category-view';

/** `GET /catalog/categories` (public, no permission required — §7.2/§8.1): full active
 * category tree, ordered by `sortOrder`. */
@Injectable()
export class GetCategoryTreeQuery {
  constructor(@Inject(CATEGORY_REPOSITORY) private readonly categories: ICategoryRepository) {}

  async execute(): Promise<CategoryTreeNode[]> {
    const categories = await this.categories.listActive();
    return buildCategoryTree(categories);
  }
}
