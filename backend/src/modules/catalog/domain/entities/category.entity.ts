import { CatalogErrors } from '../errors';
import { CategoryAppliesTo } from '../enums';

export interface CategoryProps {
  id: string;
  parentId: string | null;
  slug: string;
  nameAm: string | null;
  nameEn: string | null;
  appliesTo: CategoryAppliesTo;
  sortOrder: number;
  isActive: boolean;
}

export interface NewCategoryProps {
  parentId?: string | null;
  slug: string;
  nameAm?: string | null;
  nameEn?: string | null;
  appliesTo?: CategoryAppliesTo;
  sortOrder?: number;
}

/** `slug` is immutable after create (§3.2) — never present in `CategoryEdits`. */
export interface CategoryEdits {
  parentId?: string | null;
  nameAm?: string | null;
  nameEn?: string | null;
  appliesTo?: CategoryAppliesTo;
  sortOrder?: number;
  isActive?: boolean;
}

/** Category entity, hierarchical (module-03 §3.2). Framework-free. Cycle detection needs the
 * DB-resolved ancestor chain, so it lives in the application layer via `CategoryCycleGuard`. */
export class Category {
  private constructor(private props: CategoryProps) {}

  static rehydrate(props: CategoryProps): Category {
    return new Category(props);
  }

  static create(id: string, input: NewCategoryProps): Category {
    Category.assertHasName(input.nameAm ?? null, input.nameEn ?? null);
    return new Category({
      id,
      parentId: input.parentId ?? null,
      slug: input.slug,
      nameAm: input.nameAm ?? null,
      nameEn: input.nameEn ?? null,
      appliesTo: input.appliesTo ?? CategoryAppliesTo.BOTH,
      sortOrder: input.sortOrder ?? 0,
      isActive: true,
    });
  }

  get id(): string {
    return this.props.id;
  }
  get parentId(): string | null {
    return this.props.parentId;
  }
  get isActive(): boolean {
    return this.props.isActive;
  }

  applyEdits(edits: CategoryEdits): string[] {
    const changed: string[] = [];
    const next = { ...this.props };

    const setIfDefined = <K extends keyof CategoryEdits>(key: K): void => {
      if (edits[key] !== undefined) {
        (next as Record<string, unknown>)[key] = edits[key];
        changed.push(key as string);
      }
    };

    setIfDefined('parentId');
    setIfDefined('nameAm');
    setIfDefined('nameEn');
    setIfDefined('appliesTo');
    setIfDefined('sortOrder');
    setIfDefined('isActive');

    if (changed.length === 0) {
      return changed;
    }

    if (changed.includes('nameAm') || changed.includes('nameEn')) {
      Category.assertHasName(next.nameAm, next.nameEn);
    }

    this.props = next;
    return changed;
  }

  disable(): void {
    this.props.isActive = false;
  }

  /** §4.3: at least one of `nameAm`/`nameEn` required. */
  private static assertHasName(nameAm: string | null, nameEn: string | null): void {
    if (!nameAm && !nameEn) {
      throw CatalogErrors.validation('Provide nameAm or nameEn.', { field: 'nameEn' });
    }
  }

  toProps(): Readonly<CategoryProps> {
    return { ...this.props };
  }
}
