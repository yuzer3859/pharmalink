import type {
  AuditLog,
  InventoryItem,
  MedicineForm,
  Order,
  OrderStatus,
  PaymentStatus,
  Pharmacy,
  Role,
  StaffMember,
  StockStatus,
} from '@/types';

// Deterministic pseudo-random generator so data is stable across reloads.
let seedState = 987654321;
const rand = () => {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
};
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const int = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const daysFromNow = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

export const PHARMACIES: Pharmacy[] = [
  'Kenema Pharmacy',
  'Bethel Pharmacy',
  'Teklehaimanot Pharmacy',
  'Gishen Pharmacy',
  'Zewditu Pharmacy',
  'Selam Pharmacy',
].map((name, i) => ({
  id: `ph-${i + 1}`,
  name,
  licenseNo: `EFDA-${2020 + i}-${1000 + i * 37}`,
  licenseExpiry: daysFromNow(int(-30, 400)),
  city: pick(['Addis Ababa', 'Adama', 'Bahir Dar', 'Hawassa', 'Mekelle', 'Dire Dawa']),
  status: i === 4 ? 'pending' : i === 5 ? 'suspended' : 'active',
  rating: Number((3.6 + rand() * 1.4).toFixed(1)),
  ordersThisMonth: int(120, 1600),
  revenueThisMonth: int(180000, 2400000),
  staffCount: int(3, 22),
  joinedAt: daysFromNow(-int(90, 900)),
}));

const CURRENT_PHARMACY = PHARMACIES[0];

const MEDICINES: Array<{ name: string; generic: string; cat: string; form: MedicineForm; rx: boolean }> = [
  { name: 'Panadol Extra', generic: 'Paracetamol + Caffeine', cat: 'Analgesics', form: 'Tablet', rx: false },
  { name: 'Amoxil 500', generic: 'Amoxicillin', cat: 'Antibiotics', form: 'Capsule', rx: true },
  { name: 'Ventolin', generic: 'Salbutamol', cat: 'Respiratory', form: 'Injection', rx: true },
  { name: 'Augmentin 625', generic: 'Amoxicillin + Clavulanate', cat: 'Antibiotics', form: 'Tablet', rx: true },
  { name: 'Brufen 400', generic: 'Ibuprofen', cat: 'Analgesics', form: 'Tablet', rx: false },
  { name: 'Metformin 850', generic: 'Metformin', cat: 'Antidiabetic', form: 'Tablet', rx: true },
  { name: 'Amlor 5mg', generic: 'Amlodipine', cat: 'Cardiovascular', form: 'Tablet', rx: true },
  { name: 'Zinnat Syrup', generic: 'Cefuroxime', cat: 'Antibiotics', form: 'Syrup', rx: true },
  { name: 'Vitamin C 1000', generic: 'Ascorbic Acid', cat: 'Supplements', form: 'Tablet', rx: false },
  { name: 'Omeprazole 20', generic: 'Omeprazole', cat: 'Gastro', form: 'Capsule', rx: false },
  { name: 'Voltaren Gel', generic: 'Diclofenac', cat: 'Analgesics', form: 'Cream', rx: false },
  { name: 'Tobrex', generic: 'Tobramycin', cat: 'Ophthalmic', form: 'Drops', rx: true },
  { name: 'Coartem', generic: 'Artemether + Lumefantrine', cat: 'Antimalarial', form: 'Tablet', rx: true },
  { name: 'Losec 40', generic: 'Omeprazole', cat: 'Gastro', form: 'Injection', rx: true },
  { name: 'Claritin', generic: 'Loratadine', cat: 'Antihistamine', form: 'Tablet', rx: false },
];

const deriveStatus = (qty: number, reorder: number, expiry: string): StockStatus => {
  if (new Date(expiry).getTime() < Date.now()) return 'expired';
  if (qty === 0) return 'out_of_stock';
  if (qty <= reorder) return 'low_stock';
  return 'in_stock';
};

export const INVENTORY: InventoryItem[] = [];
PHARMACIES.forEach((ph) => {
  MEDICINES.forEach((m, idx) => {
    const qty = int(0, 800);
    const reorder = int(40, 120);
    const expiry = daysFromNow(int(-20, 720));
    INVENTORY.push({
      id: `inv-${ph.id}-${idx}`,
      sku: `SKU-${ph.id.toUpperCase()}-${(idx + 1).toString().padStart(3, '0')}`,
      name: m.name,
      genericName: m.generic,
      category: m.cat,
      form: m.form,
      strength: pick(['250mg', '500mg', '5mg', '10ml', '20mg', '400mg']),
      requiresRx: m.rx,
      price: int(15, 950),
      quantity: qty,
      reorderLevel: reorder,
      batchNo: `B${int(1000, 9999)}`,
      expiryDate: expiry,
      pharmacyId: ph.id,
      pharmacyName: ph.name,
      status: deriveStatus(qty, reorder, expiry),
      updatedAt: daysFromNow(-int(0, 30)),
    });
  });
});

const ORDER_STATUSES: OrderStatus[] = [
  'placed', 'verified', 'accepted', 'dispatched', 'delivered', 'completed', 'cancelled',
];
const PAY_STATUSES: PaymentStatus[] = ['pending', 'authorized', 'paid', 'refunded', 'failed'];
const CUSTOMERS = [
  'Abebe Kebede', 'Sara Tesfaye', 'Dawit Bekele', 'Marta Girma', 'Yonas Alemu',
  'Hana Mekonnen', 'Samuel Tadesse', 'Lidya Haile', 'Bereket Assefa', 'Rahel Desta',
];

export const ORDERS: Order[] = Array.from({ length: 140 }).map((_, i) => {
  const ph = pick(PHARMACIES);
  const lineCount = int(1, 4);
  const lines = Array.from({ length: lineCount }).map(() => {
    const m = pick(MEDICINES);
    const q = int(1, 5);
    return { itemId: `it-${int(1, 999)}`, name: m.name, quantity: q, unitPrice: int(15, 950) };
  });
  const total = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) + int(40, 120);
  const status = pick(ORDER_STATUSES);
  return {
    id: `ord-${i + 1}`,
    reference: `PL-${daysFromNow(-int(0, 45)).slice(2, 10).replace(/-/g, '')}-${1000 + i}`,
    customerName: pick(CUSTOMERS),
    pharmacyId: ph.id,
    pharmacyName: ph.name,
    status,
    paymentStatus:
      status === 'cancelled' ? 'refunded' : status === 'completed' ? 'paid' : pick(PAY_STATUSES),
    requiresRx: lines.some(() => rand() > 0.6),
    total,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    lines,
    createdAt: daysFromNow(-int(0, 45)),
    deliveryZone: pick(['Bole', 'Kirkos', 'Yeka', 'Arada', 'Nifas Silk', 'Gullele']),
  };
});

const ALL_PERMISSIONS = [
  'dashboard:view', 'inventory:view', 'inventory:manage', 'orders:view', 'orders:manage',
  'analytics:view', 'reports:view', 'reports:export', 'staff:view', 'staff:manage',
  'roles:view', 'roles:manage', 'pharmacies:view', 'pharmacies:manage', 'audit:view', 'settings:manage',
] as const;

export const ROLES: Role[] = [
  {
    id: 'role-1', name: 'Pharmacy Owner', portal: 'pharmacy', isSystem: true, memberCount: 6,
    description: 'Full control over a single pharmacy: inventory, orders, staff and reports.',
    permissions: ['dashboard:view', 'inventory:view', 'inventory:manage', 'orders:view', 'orders:manage', 'analytics:view', 'reports:view', 'reports:export', 'staff:view', 'staff:manage'],
  },
  {
    id: 'role-2', name: 'Pharmacist', portal: 'pharmacy', isSystem: true, memberCount: 18,
    description: 'Verifies prescriptions and manages order fulfilment.',
    permissions: ['dashboard:view', 'inventory:view', 'orders:view', 'orders:manage'],
  },
  {
    id: 'role-3', name: 'Inventory Clerk', portal: 'pharmacy', isSystem: false, memberCount: 11,
    description: 'Maintains stock levels and product catalogue.',
    permissions: ['dashboard:view', 'inventory:view', 'inventory:manage'],
  },
  {
    id: 'role-4', name: 'Operations Admin', portal: 'admin', isSystem: true, memberCount: 4,
    description: 'Oversees pharmacies, orders and platform reporting.',
    permissions: ['dashboard:view', 'pharmacies:view', 'pharmacies:manage', 'orders:view', 'orders:manage', 'inventory:view', 'analytics:view', 'reports:view', 'reports:export', 'staff:view', 'staff:manage', 'roles:view'],
  },
  {
    id: 'role-5', name: 'Compliance Officer', portal: 'admin', isSystem: false, memberCount: 3,
    description: 'Monitors licensing, controlled substances and audit trails.',
    permissions: ['dashboard:view', 'pharmacies:view', 'reports:view', 'reports:export', 'audit:view'],
  },
  {
    id: 'role-6', name: 'Super Administrator', portal: 'superadmin', isSystem: true, memberCount: 2,
    description: 'Unrestricted platform-wide access including settings and role management.',
    permissions: [...ALL_PERMISSIONS],
  },
  {
    id: 'role-7', name: 'Platform Auditor', portal: 'superadmin', isSystem: false, memberCount: 2,
    description: 'Read and audit access across all tenants.',
    permissions: ['dashboard:view', 'analytics:view', 'reports:view', 'reports:export', 'audit:view', 'pharmacies:view'],
  },
];

const STAFF_NAMES = [
  'Kalkidan Girma', 'Nahom Tesfaye', 'Meron Assefa', 'Biruk Hailu', 'Selamawit Bekele',
  'Tewodros Alemu', 'Eden Fikru', 'Robel Getachew', 'Feven Solomon', 'Amanuel Yohannes',
  'Tsion Abebe', 'Henok Desta', 'Blen Mulugeta', 'Yared Tadesse', 'Hiwot Negash',
];

export const STAFF: StaffMember[] = STAFF_NAMES.map((name, i) => {
  const role = pick(ROLES);
  const ph = pick(PHARMACIES);
  return {
    id: `staff-${i + 1}`,
    name,
    email: `${name.toLowerCase().replace(/ /g, '.')}@pharmalink.et`,
    phone: `+2519${int(10000000, 99999999)}`,
    roleId: role.id,
    roleName: role.name,
    status: pick<StaffMember['status']>(['active', 'active', 'active', 'invited', 'suspended']),
    pharmacyId: role.portal === 'pharmacy' ? ph.id : undefined,
    pharmacyName: role.portal === 'pharmacy' ? ph.name : undefined,
    lastActiveAt: daysFromNow(-int(0, 20)),
    createdAt: daysFromNow(-int(30, 700)),
  };
});

export const AUDIT_LOGS: AuditLog[] = Array.from({ length: 60 }).map((_, i) => ({
  id: `log-${i + 1}`,
  actor: pick(STAFF_NAMES),
  action: pick([
    'Approved prescription', 'Suspended pharmacy', 'Updated role permissions',
    'Exported revenue report', 'Adjusted stock level', 'Issued refund',
    'Created staff account', 'Changed platform settings', 'Rejected provider application',
  ]),
  entity: pick(['Order', 'Pharmacy', 'Role', 'Report', 'Inventory', 'Payment', 'Staff', 'Settings']),
  severity: pick<AuditLog['severity']>(['info', 'info', 'info', 'warning', 'critical']),
  ip: `10.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`,
  timestamp: daysFromNow(-int(0, 14)),
}));

export { CURRENT_PHARMACY, ALL_PERMISSIONS };
