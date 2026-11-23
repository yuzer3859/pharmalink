import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { DOSAGE_FORM_ALLOWLIST, STRENGTH_UNIT_ALLOWLIST } from '../../modules/catalog/domain/enums';
import { PRODUCT_IMAGE_URL } from '../../modules/catalog/interface/dtos/product.dto';
import { FIXTURE_PRODUCTS } from './fixtures';
import { SHELF_CATEGORIES, SHELF_PRODUCTS, WALK_PRODUCT_SHELF } from './shelf-fixtures';

/** Work 146: the shelf fixtures agree with each other, with the catalogue rules and with the pictures. */
describe('staging shelf fixtures (Work 146)', () => {
  const productsDir = join(__dirname, '..', '..', '..', '..', 'app', 'public', 'products');
  const pictures = [...SHELF_PRODUCTS.map((p) => p.image), ...WALK_PRODUCT_SHELF.map((w) => w.image)];

  it('has unique keys, names and category slugs, and every product names a shelf category', () => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    expect(unique(SHELF_PRODUCTS.map((p) => p.key))).toBe(true);
    expect(unique(SHELF_PRODUCTS.map((p) => p.nameEn))).toBe(true);
    expect(unique(SHELF_CATEGORIES.map((c) => c.slug))).toBe(true);
    const slugs = new Set(SHELF_CATEGORIES.map((c) => c.slug));
    for (const p of SHELF_PRODUCTS) expect({ key: p.key, ok: slugs.has(p.category) }).toEqual({ key: p.key, ok: true });
    for (const w of WALK_PRODUCT_SHELF) expect(slugs.has(w.category)).toBe(true);
  });

  it('never reuses a walk fixture name, and every walk product it pictures exists', () => {
    const walkNames = new Set(FIXTURE_PRODUCTS.map((p) => p.nameEn));
    for (const p of SHELF_PRODUCTS) expect(walkNames.has(p.nameEn)).toBe(false);
    for (const w of WALK_PRODUCT_SHELF) expect(FIXTURE_PRODUCTS.some((p) => p.key === w.fixtureKey)).toBe(true);
  });

  it('follows the catalogue rules: positive integer prices, known dosage forms and units', () => {
    for (const p of SHELF_PRODUCTS) {
      expect(Number.isInteger(p.price) && p.price > 0).toBe(true);
      if (p.type === 'MEDICINE') {
        expect(DOSAGE_FORM_ALLOWLIST).toContain(p.dosageForm);
        if (p.strength) expect(STRENGTH_UNIT_ALLOWLIST).toContain(p.strength.unit);
      }
    }
  });

  it('covers the whole pharmacy range, not only medicines', () => {
    const used = new Set(SHELF_PRODUCTS.map((p) => p.category));
    expect(used).toEqual(new Set(SHELF_CATEGORIES.map((c) => c.slug)));
    expect(SHELF_PRODUCTS.filter((p) => p.type === 'HEALTH_PRODUCT').length).toBeGreaterThan(30);
  });

  it('has a picture file for every product, with a valid image URL, credited in CREDITS.md', () => {
    const credits = readFileSync(join(productsDir, 'CREDITS.md'), 'utf8');
    for (const file of pictures) {
      expect({ file, exists: existsSync(join(productsDir, file)) }).toEqual({ file, exists: true });
      expect(`/products/${file}`).toMatch(PRODUCT_IMAGE_URL);
      expect({ file, credited: credits.includes(`\`${file}\``) }).toEqual({ file, credited: true });
    }
  });
});
