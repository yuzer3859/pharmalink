// Domain types for PharmaLink Ethiopia operations console.

export type PortalKey = 'pharmacy' | 'admin' | 'superadmin';

export type PermissionKey =
  | 'dashboard:view'
  | 'inventory:view'
  | 'inventory:manage'
  | 'orders:view'
  | 'orders:manage'
  | 'analytics:view'
  | 'reports:view'
  | 'reports:export'
  | 'staff:view'
  | 'staff:manage'
  | 'roles:view'
  | 'roles:manage'
  | 'pharmacies:view'
  | 'pharmacies:manage'
  | 'audit:view'
  | 'settings:manage';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatarColor: string;
  portal: PortalKey;
  roleName: string;
  permissions: PermissionKey[];
  pharmacyId?: string;
  pharmacyName?: string;
}

// ----- Inventory -----
export type MedicineForm = 'Tablet' | 'Capsule' | 'Syrup' | 'Injection' | 'Cream' | 'Drops';
export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'expired';

export interface InventoryItem {
  id: string;
  sku: string;
  name: string;
  genericName: string;
  category: string;
  form: MedicineForm;
  strength: string;
  requiresRx: boolean;
  price: number;
  quantity: number;
  reorderLevel: number;
  batchNo: string;
  expiryDate: string; // ISO
  pharmacyId: string;
  pharmacyName: string;
  status: StockStatus;
  updatedAt: string;
}

// ----- Orders -----
export type OrderStatus =
  | 'placed'
  | 'verified'
  | 'accepted'
  | 'dispatched'
  | 'delivered'
  | 'completed'
  | 'cancelled';

export type PaymentStatus = 'pending' | 'authorized' | 'paid' | 'refunded' | 'failed';

export interface OrderLine {
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  reference: string;
  customerName: string;
  pharmacyId: string;
  pharmacyName: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  requiresRx: boolean;
  total: number;
  itemCount: number;
  lines: OrderLine[];
  createdAt: string;
  deliveryZone: string;
}

// ----- Staff -----
export type StaffStatus = 'active' | 'invited' | 'suspended';

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  phone: string;
  roleId: string;
  roleName: string;
  status: StaffStatus;
  pharmacyId?: string;
  pharmacyName?: string;
  lastActiveAt: string;
  createdAt: string;
}

// ----- Roles -----
export interface Role {
  id: string;
  name: string;
  description: string;
  portal: PortalKey;
  permissions: PermissionKey[];
  memberCount: number;
  isSystem: boolean;
}

// ----- Pharmacies (providers) -----
export type PharmacyStatus = 'active' | 'pending' | 'suspended';

export interface Pharmacy {
  id: string;
  name: string;
  licenseNo: string;
  licenseExpiry: string;
  city: string;
  status: PharmacyStatus;
  rating: number;
  ordersThisMonth: number;
  revenueThisMonth: number;
  staffCount: number;
  joinedAt: string;
}

export type TransactingStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING';
export type LicenseStatus = 'VALID' | 'EXPIRED' | 'SUSPENDED';

/**
 * One pharmacy as `GET /admin/operations/pharmacies` reports it: stored statuses, licence expiry,
 * eligibility and counts. The API returns no name, owner, contact, address or licence number.
 */
export interface PharmacyOperations {
  pharmacyId: string;
  transactingStatus: TransactingStatus;
  licenseStatus: LicenseStatus;
  licenseExpiresAt: string | null;
  /** Server-computed: may transact now (active, valid and unexpired licence). */
  eligible: boolean;
  createdAt: string;
  updatedAt: string;
  branches: { total: number; active: number };
  listings: {
    total: number;
    enabled: number;
    disabled: number;
    inStock: number;
    outOfStock: number;
    customerPurchasable: number;
    customerUnpurchasable: number;
  };
}

export interface PharmacyOperationsPage {
  items: PharmacyOperations[];
  total: number;
  page: number;
  size: number;
}

export type AdminOrderStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'ACCEPTED'
  | 'READY'
  | 'DISPATCHED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED';

/**
 * One order as `GET /admin/operations/orders` reports it: Module 06's columns, no customer data.
 * Money is in integer minor units.
 */
export interface AdminOrderSummary {
  orderId: string;
  orderNumber: string;
  status: AdminOrderStatus;
  isCod: boolean;
  grandTotal: number;
  currency: string;
  lineCount: number;
  fulfillmentCount: number;
  placedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOrderListItem extends AdminOrderSummary {
  hasDeliveryJobReference: boolean;
  unreferencedFulfillmentCount: number;
}

export interface AdminOrderPage {
  items: AdminOrderListItem[];
  total: number;
  page: number;
  size: number;
}

export interface AdminOrderDetail extends AdminOrderSummary {
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  discountTotal: number;
  completedAt: string | null;
  cancelledAt: string | null;
  fulfillments: Array<{
    fulfillmentId: string;
    pharmacyId: string;
    branchId: string;
    status: string;
    deliveryJobId: string | null;
    acceptedAt: string | null;
    readyAt: string | null;
    createdAt: string;
  }>;
  payment: { paymentId: string; status: string; method: string; updatedAt: string } | null;
}

// ----- Analytics -----
export interface KpiMetric {
  key: string;
  label: string;
  value: number;
  unit?: string;
  deltaPct: number; // period over period
  format: 'number' | 'currency' | 'percent';
}

export interface TimeSeriesPoint {
  period: string;
  [series: string]: string | number;
}

export interface CategoryDatum {
  name: string;
  value: number;
}

export interface AnalyticsBundle {
  kpis: KpiMetric[];
  revenueTrend: TimeSeriesPoint[];
  ordersByStatus: CategoryDatum[];
  topCategories: CategoryDatum[];
  fulfillmentTrend: TimeSeriesPoint[];
}

// ----- Reports -----
export type ReportStatus = 'ready' | 'scheduled' | 'generating' | 'failed';

export interface ReportRecord {
  id: string;
  name: string;
  type: string;
  period: string;
  status: ReportStatus;
  format: 'PDF' | 'CSV' | 'XLSX';
  sizeKb: number;
  generatedAt: string;
  generatedBy: string;
}

// ----- Audit -----
/** One entry of the hash-chained audit trail, as `GET /admin/audit` returns it. */
export interface AuditLog {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  /** The writing module's own record of what happened; secrets are never written to it. */
  context: unknown;
  ip: string | null;
  createdAt: string;
  chain: { prevHash: string | null; hash: string };
}

export interface AuditLogPage {
  items: AuditLog[];
  total: number;
  page: number;
  size: number;
}

// ----- Query filters -----
export interface Paginated<T> {
  rows: T[];
  total: number;
}
