/**
 * Work 146 (owner request 2026-11-23): the staging pharmacy shelf. A full pharmacy range, not only
 * medicines: make-up and skin care, oral care, personal care, baby care, first aid, medical devices
 * and mobility aids. Every product has a picture under the customer app's `/products/` folder
 * (`app/public/products/`, credited in `app/public/products/CREDITS.md`) and is stocked and priced
 * at Seed Bole Pharmacy's Bole Main branch, so a customer can order it.
 *
 * Synthetic staging data only: names are generic, prices are illustrative, and no product is a
 * real brand. Prices are ETB minor units (santim).
 */

export interface ShelfCategory {
  slug: string;
  nameEn: string;
  /** Draft Amharic, for the owner's review. */
  nameAm: string;
  appliesTo: 'MEDICINE' | 'HEALTH_PRODUCT' | 'BOTH';
}

export const SHELF_CATEGORIES: readonly ShelfCategory[] = [
  { slug: 'pain-fever', nameEn: 'Pain & fever', nameAm: 'ህመምና ትኩሳት', appliesTo: 'MEDICINE' },
  { slug: 'cold-flu', nameEn: 'Cold, flu & allergy', nameAm: 'ጉንፋንና አለርጂ', appliesTo: 'MEDICINE' },
  { slug: 'digestive', nameEn: 'Digestive health', nameAm: 'የምግብ መፈጨት ጤና', appliesTo: 'MEDICINE' },
  { slug: 'antibiotics', nameEn: 'Antibiotics', nameAm: 'አንቲባዮቲኮች', appliesTo: 'MEDICINE' },
  { slug: 'vitamins', nameEn: 'Vitamins & supplements', nameAm: 'ቫይታሚኖችና ተጨማሪ ምግቦች', appliesTo: 'BOTH' },
  { slug: 'beauty', nameEn: 'Make-up & beauty', nameAm: 'መዋቢያዎች', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'skin-care', nameEn: 'Skin care', nameAm: 'የቆዳ እንክብካቤ', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'oral-care', nameEn: 'Oral care', nameAm: 'የአፍና የጥርስ እንክብካቤ', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'personal-care', nameEn: 'Personal care', nameAm: 'የግል ንጽሕና', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'baby-mother', nameEn: 'Baby & mother', nameAm: 'እናትና ሕፃን', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'first-aid', nameEn: 'First aid', nameAm: 'የመጀመሪያ ዕርዳታ', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'devices', nameEn: 'Medical devices', nameAm: 'የሕክምና መሣሪያዎች', appliesTo: 'HEALTH_PRODUCT' },
  { slug: 'mobility', nameEn: 'Mobility aids', nameAm: 'የእንቅስቃሴ ድጋፍ መሣሪያዎች', appliesTo: 'HEALTH_PRODUCT' },
];

interface ShelfBase {
  key: string;
  nameEn: string;
  category: string;
  price: number;
  packSize: string;
  descriptionEn: string;
  /** The file in `app/public/products/`; served as `/products/<image>`. */
  image: string;
}

export interface ShelfMedicine extends ShelfBase {
  type: 'MEDICINE';
  genericName: string;
  dosageForm: string;
  strength: { value: number; unit: string } | null;
  rx: 'OTC' | 'RX';
}

export interface ShelfHealthProduct extends ShelfBase {
  type: 'HEALTH_PRODUCT';
}

export type ShelfProduct = ShelfMedicine | ShelfHealthProduct;

const med = (
  key: string,
  nameEn: string,
  category: string,
  genericName: string,
  dosageForm: string,
  strength: ShelfMedicine['strength'],
  rx: ShelfMedicine['rx'],
  price: number,
  packSize: string,
  descriptionEn: string,
  image = `${key}.webp`,
): ShelfMedicine => ({ type: 'MEDICINE', key, nameEn, category, genericName, dosageForm, strength, rx, price, packSize, descriptionEn, image });

const item = (key: string, nameEn: string, category: string, price: number, packSize: string, descriptionEn: string, image = `${key}.webp`): ShelfHealthProduct => ({
  type: 'HEALTH_PRODUCT',
  key,
  nameEn,
  category,
  price,
  packSize,
  descriptionEn,
  image,
});

export const SHELF_PRODUCTS: readonly ShelfProduct[] = [
  // Medicines
  med('paracetamol', 'Paracetamol 500 mg tablets', 'pain-fever', 'Paracetamol', 'TABLET', { value: 500, unit: 'MG' }, 'OTC', 4_500, '20 tablets', 'Relieves mild to moderate pain and lowers fever.'),
  med('ibuprofen', 'Ibuprofen 400 mg tablets', 'pain-fever', 'Ibuprofen', 'TABLET', { value: 400, unit: 'MG' }, 'OTC', 6_500, '20 tablets', 'An anti-inflammatory for pain, swelling and fever. Take with food.'),
  med('diclofenac-gel', 'Diclofenac 1% gel', 'pain-fever', 'Diclofenac', 'CREAM', { value: 1, unit: 'PERCENT' }, 'OTC', 18_000, '50 g tube', 'Rub gently on sore muscles and joints up to three times a day.'),
  med('cough-syrup', 'Dextromethorphan cough syrup 100 ml', 'cold-flu', 'Dextromethorphan', 'SYRUP', { value: 15, unit: 'MG' }, 'OTC', 14_500, '100 ml bottle', 'Soothes a dry, tickly cough. Not for children under 6.'),
  med('cetirizine', 'Cetirizine 10 mg tablets', 'cold-flu', 'Cetirizine', 'TABLET', { value: 10, unit: 'MG' }, 'OTC', 7_500, '10 tablets', 'Once-a-day relief from hay fever and allergy symptoms.'),
  med('antacid', 'Calcium carbonate antacid chewable tablets', 'digestive', 'Calcium carbonate', 'TABLET', { value: 500, unit: 'MG' }, 'OTC', 9_000, '24 tablets', 'Fast relief from heartburn and indigestion. Chew one or two tablets.'),
  med('azithromycin', 'Azithromycin 500 mg tablets', 'antibiotics', 'Azithromycin', 'TABLET', { value: 500, unit: 'MG' }, 'RX', 22_000, '3 tablets', 'A prescription antibiotic. A pharmacist checks your prescription first.'),
  med('metronidazole', 'Metronidazole 400 mg tablets', 'antibiotics', 'Metronidazole', 'TABLET', { value: 400, unit: 'MG' }, 'RX', 8_500, '14 tablets', 'A prescription antibiotic. Avoid alcohol while taking it.'),
  // Vitamins & supplements
  med('multivitamin', 'Daily multivitamin tablets', 'vitamins', 'Multivitamins and minerals', 'TABLET', null, 'OTC', 32_000, '30 tablets', 'One tablet a day with breakfast, for everyday vitamins and minerals.'),
  med('vitamin-c', 'Vitamin C 1000 mg effervescent tablets', 'vitamins', 'Ascorbic acid', 'TABLET', { value: 1000, unit: 'MG' }, 'OTC', 16_500, '20 tablets', 'Dissolve one tablet in a glass of water. Orange flavour.'),
  item('omega-3', 'Omega-3 fish oil capsules', 'vitamins', 38_000, '60 capsules', 'Fish oil rich in EPA and DHA, for heart and brain health.'),
  med('iron-folic', 'Iron and folic acid tablets', 'vitamins', 'Ferrous sulfate and folic acid', 'TABLET', null, 'OTC', 6_000, '30 tablets', 'Supports healthy blood, especially during pregnancy.'),
  med('vitamin-d', 'Vitamin D3 1000 IU softgels', 'vitamins', 'Cholecalciferol', 'CAPSULE', { value: 1000, unit: 'IU' }, 'OTC', 24_000, '60 softgels', 'For strong bones and teeth. One softgel a day.'),
  // Make-up & beauty
  item('lipstick', 'Matte lipstick, ruby red', 'beauty', 45_000, '3.5 g', 'Long-lasting matte colour that keeps lips soft.'),
  item('foundation', 'Liquid foundation, medium', 'beauty', 85_000, '30 ml', 'Light, buildable coverage with a natural finish.'),
  item('mascara', 'Volumising mascara, black', 'beauty', 52_000, '10 ml', 'Lifts and thickens lashes without clumping.'),
  item('face-powder', 'Pressed face powder compact', 'beauty', 48_000, '10 g with mirror', 'Sets make-up and takes away shine. Includes a mirror and puff.'),
  item('nail-polish', 'Nail polish, coral', 'beauty', 22_000, '12 ml', 'Glossy, quick-drying colour.'),
  item('brush-set', 'Make-up brush set, 8 pieces', 'beauty', 95_000, '8 brushes with pouch', 'Soft synthetic brushes for face and eyes, in a travel pouch.'),
  // Skin care
  item('sunscreen', 'Sunscreen SPF 50, 100 ml', 'skin-care', 68_000, '100 ml', 'Broad-spectrum protection that absorbs quickly without a white cast.'),
  item('moisturiser', 'Daily moisturising cream, 50 ml', 'skin-care', 42_000, '50 ml jar', 'Hydrates for 24 hours. Suitable for sensitive skin.'),
  item('cleanser', 'Gentle facial cleanser, 150 ml', 'skin-care', 36_000, '150 ml', 'Removes dirt and make-up without drying the skin.'),
  item('body-lotion', 'Shea body lotion, 400 ml', 'skin-care', 39_000, '400 ml', 'Rich shea butter lotion for dry skin.'),
  // Oral care
  item('toothbrush', 'Soft toothbrush', 'oral-care', 6_500, '1 toothbrush', 'Soft, rounded bristles that are gentle on gums.'),
  item('electric-toothbrush', 'Rechargeable electric toothbrush', 'oral-care', 280_000, '1 handle, 2 heads, charger', 'Two-minute timer and a week of charge.'),
  item('toothpaste', 'Fluoride toothpaste, 100 ml', 'oral-care', 9_500, '100 ml tube', 'Protects against cavities and freshens breath.'),
  item('floss', 'Dental floss, mint, 50 m', 'oral-care', 8_000, '50 m', 'Waxed mint floss that slides easily between teeth.'),
  item('mouthwash', 'Antiseptic mouthwash, 500 ml', 'oral-care', 24_000, '500 ml', 'Kills germs that cause bad breath and plaque.'),
  // Personal care
  item('sanitiser', 'Hand sanitiser 70% alcohol, 500 ml', 'personal-care', 17_500, '500 ml pump', 'Kills 99.9% of germs without water.'),
  item('shampoo', 'Nourishing shampoo, 400 ml', 'personal-care', 28_000, '400 ml', 'Cleans and softens all hair types.'),
  item('deodorant', 'Roll-on deodorant, 50 ml', 'personal-care', 15_000, '50 ml', '48-hour freshness, alcohol-free.'),
  item('pads', 'Sanitary pads, regular, 10 pack', 'personal-care', 7_500, '10 pads', 'Soft, absorbent pads with wings.'),
  item('cotton', 'Cotton wool pads, 100 pack', 'personal-care', 6_000, '100 pads', 'Soft cotton pads for make-up removal and skin care.'),
  // Baby & mother
  item('diapers', 'Baby diapers, size 3, 40 pack', 'baby-mother', 72_000, '40 diapers', 'Up to 12 hours of dryness, for babies 4 to 9 kg.'),
  item('wipes', 'Baby wipes, fragrance-free, 80 pack', 'baby-mother', 14_000, '80 wipes', 'Gentle, fragrance-free wipes for sensitive skin.'),
  item('feeding-bottle', 'Baby feeding bottle, 250 ml', 'baby-mother', 26_000, '1 bottle', 'Anti-colic bottle with a slow-flow teat. BPA-free.'),
  item('baby-lotion', 'Gentle baby lotion, 200 ml', 'baby-mother', 19_500, '200 ml', 'Mild lotion that keeps baby skin soft.'),
  // First aid
  item('bandages', 'Adhesive bandages, 40 assorted', 'first-aid', 8_500, '40 bandages', 'Breathable plasters in assorted sizes.'),
  item('first-aid-kit', 'Home first aid kit', 'first-aid', 120_000, '45 pieces', 'Bandages, gauze, tape, scissors, gloves and antiseptic wipes in a case.'),
  item('elastic-bandage', 'Elastic bandage, 10 cm', 'first-aid', 9_000, '1 roll, 4.5 m', 'Supports sprains and holds dressings in place.'),
  item('antiseptic', 'Antiseptic solution, 250 ml', 'first-aid', 16_000, '250 ml', 'Cleans cuts, grazes and minor wounds.'),
  item('gauze', 'Sterile gauze swabs, 10 pack', 'first-aid', 5_500, '10 swabs', 'Individually wrapped sterile swabs.'),
  // Medical devices
  item('thermometer', 'Digital thermometer', 'devices', 25_000, '1 thermometer', 'Reads temperature in about 10 seconds, with a fever alarm.'),
  item('bp-monitor', 'Upper-arm blood pressure monitor', 'devices', 320_000, '1 monitor with cuff', 'Automatic readings with memory for two users.'),
  item('glucometer', 'Blood glucose meter kit', 'devices', 185_000, 'Meter, 10 strips, lancets', 'Results in 5 seconds from a small drop of blood.'),
  item('oximeter', 'Fingertip pulse oximeter', 'devices', 95_000, '1 oximeter', 'Shows blood oxygen and pulse rate in seconds.'),
  item('masks', 'Disposable face masks, 50 pack', 'devices', 12_000, '50 masks', 'Three-layer masks with ear loops.'),
  item('stethoscope', 'Dual-head stethoscope', 'devices', 145_000, '1 stethoscope', 'Lightweight stethoscope for home and clinic use.'),
  // Mobility aids
  item('wheelchair', 'Folding wheelchair', 'mobility', 1_250_000, '1 wheelchair', 'Lightweight steel frame that folds flat, with removable footrests.'),
  item('crutches', 'Adjustable underarm crutches, pair', 'mobility', 180_000, '1 pair', 'Aluminium crutches with padded tops and non-slip tips.'),
  item('walker', 'Folding walking frame', 'mobility', 290_000, '1 frame', 'Height-adjustable aluminium frame that folds for storage.'),
  item('cane', 'Adjustable walking cane', 'mobility', 65_000, '1 cane', 'Height-adjustable cane with a comfortable grip.'),
  item('knee-brace', 'Knee support brace', 'mobility', 55_000, '1 brace', 'Breathable support for weak or injured knees.'),
];

/** The Phase 1 walk products (`FIXTURE_PRODUCTS` keys) also get a picture and a category. */
export const WALK_PRODUCT_SHELF: ReadonlyArray<{ fixtureKey: string; category: string; image: string }> = [
  { fixtureKey: 'walkOtc', category: 'digestive', image: 'ors.webp' },
  { fixtureKey: 'active', category: 'antibiotics', image: 'amoxicillin.webp' },
];

/**
 * Shelf medicines name their own seed manufacturer, so the catalogue's duplicate check never
 * confuses them with the walk fixtures (Seed Paracetamol 500 mg and the like).
 */
export const SHELF_MANUFACTURER = 'Seed Shelf Pharmaceuticals';

/** Stock each shelf product starts with at Bole Main. */
export const SHELF_INITIAL_QUANTITY = 120;
