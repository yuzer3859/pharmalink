import { Category } from '../../domain/entities/category.entity';

export interface CategoryView {
  id: string;
  parentId: string | null;
  slug: string;
  nameAm: string | null;
  nameEn: string | null;
  appliesTo: string;
  sortOrder: number;
  isActive: boolean;
}

export interface CategoryTreeNode extends CategoryView {
  children: CategoryTreeNode[];
}

export function toCategoryView(category: Category): CategoryView {
  const props = category.toProps();
  return {
    id: props.id,
    parentId: props.parentId,
    slug: props.slug,
    nameAm: props.nameAm,
    nameEn: props.nameEn,
    appliesTo: props.appliesTo,
    sortOrder: props.sortOrder,
    isActive: props.isActive,
  };
}

/** Builds a nested `children[]` tree from a flat list, ordered by `sortOrder` at every level
 * (module-03 §8.1). Categories whose `parentId` is missing from the input list are treated as
 * roots (defensive — should not happen since parents are validated on write). */
export function buildCategoryTree(categories: Category[]): CategoryTreeNode[] {
  const views = categories.map(toCategoryView);
  const byId = new Map<string, CategoryTreeNode>(
    views.map((v) => [v.id, { ...v, children: [] }]),
  );
  const roots: CategoryTreeNode[] = [];

  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRecursive = (nodes: CategoryTreeNode[]): void => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    nodes.forEach((n) => sortRecursive(n.children));
  };
  sortRecursive(roots);

  return roots;
}
