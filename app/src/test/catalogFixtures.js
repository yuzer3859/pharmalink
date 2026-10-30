// Catalog/availability response bodies shaped like the backend's ProductSummaryRow,
// ProductDetailView, CategoryTreeNode and AvailabilityItem. Test data only.

export const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'
export const PRODUCT_2_ID = '22222222-2222-4222-8222-222222222222'
export const CATEGORY_ID = '33333333-3333-4333-8333-333333333333'
export const CHILD_CATEGORY_ID = '44444444-4444-4444-8444-444444444444'
export const HEALTH_CATEGORY_ID = '55555555-5555-4555-8555-555555555555'
export const PHARMACY_ID = '66666666-6666-4666-8666-666666666666'
export const BRANCH_ID = '77777777-7777-4777-8777-777777777777'
export const LISTING_ID = '88888888-8888-4888-8888-888888888888'

export const summary = (overrides = {}) => ({
  id: PRODUCT_ID,
  type: 'MEDICINE',
  brandName: 'Amoxil',
  genericName: 'Amoxicillin',
  nameAm: null,
  nameEn: 'Amoxil 500 mg capsules',
  dosageForm: 'CAPSULE',
  strengthValue: 500,
  strengthUnit: 'MG',
  rxClassification: 'RX',
  manufacturerName: 'Test Pharma PLC',
  primaryCategoryId: CATEGORY_ID,
  ...overrides,
})

export const page = (items, meta = {}) => ({ items, meta: { page: 1, size: 20, total: items.length, ...meta } })

export const detail = (overrides = {}) => ({
  id: PRODUCT_ID,
  type: 'MEDICINE',
  genericName: 'Amoxicillin',
  brandName: 'Amoxil',
  manufacturerId: null,
  dosageForm: 'CAPSULE',
  strengthValue: 500,
  strengthUnit: 'MG',
  packSize: '21 capsules',
  atcCode: 'J01CA04',
  rxClassification: 'RX',
  controlledSchedule: 'NONE',
  onlineSaleProhibited: false,
  storageRequirement: 'AMBIENT',
  equivalenceGroupId: null,
  nameAm: null,
  nameEn: 'Amoxil 500 mg capsules',
  descriptionAm: null,
  descriptionEn: 'Catalog description text.',
  warnings: 'Test warning text.',
  price: 25000,
  status: 'ACTIVE',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  categories: [{ id: CATEGORY_ID, slug: 'antibiotics', nameAm: null, nameEn: 'Antibiotics' }],
  ...overrides,
})

export const categoryTree = () => [
  {
    id: CATEGORY_ID, parentId: null, slug: 'antibiotics', nameAm: null, nameEn: 'Antibiotics',
    appliesTo: 'MEDICINE', sortOrder: 1, isActive: true,
    children: [{
      id: CHILD_CATEGORY_ID, parentId: CATEGORY_ID, slug: 'penicillins', nameAm: null, nameEn: 'Penicillins',
      appliesTo: 'MEDICINE', sortOrder: 1, isActive: true, children: [],
    }],
  },
  {
    id: HEALTH_CATEGORY_ID, parentId: null, slug: 'personal-care', nameAm: null, nameEn: 'Personal care',
    appliesTo: 'HEALTH_PRODUCT', sortOrder: 2, isActive: true, children: [],
  },
]

export const listing = (overrides = {}) => ({
  pharmacyId: PHARMACY_ID,
  branchId: BRANCH_ID,
  listingId: LISTING_ID,
  price: 31050,
  currency: 'ETB',
  sellable: 12,
  storageRequirement: 'AMBIENT',
  ...overrides,
})
