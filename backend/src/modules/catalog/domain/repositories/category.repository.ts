import { Category } from '../entities/category.entity';

export const CATEGORY_REPOSITORY = Symbol('CATEGORY_REPOSITORY');

/** Persistence port for the Category entity (module-03 §10). */
export interface ICategoryRepository {
  findById(id: string, tx?: unknown): Promise<Category | null>;
  findBySlug(slug: string): Promise<Category | null>;
  create(category: Category, tx?: unknown): Promise<void>;
  save(category: Category, tx?: unknown): Promise<void>;
  /** Active categories only, ordered by `sortOrder` (§8.1 public tree). */
  listActive(): Promise<Category[]>;
  /** Every category including inactive ones (§8.2 admin variant). */
  listAll(): Promise<Category[]>;
  /**
   * The ancestor chain starting at `categoryId` itself and walking up through `parentId` to the
   * root, e.g. `[categoryId, parent, grandparent, ...]`. Used by `CategoryCycleGuard` (§3.6
   * invariant 5) to detect a would-be cycle and to bound tree depth.
   */
  getAncestorChain(categoryId: string): Promise<string[]>;
  findManyByIds(ids: string[]): Promise<Category[]>;
}
