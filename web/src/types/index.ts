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
export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  entity: string;
  severity: 'info' | 'warning' | 'critical';
  ip: string;
  timestamp: string;
}

// ----- Query filters -----
export interface Paginated<T> {
  rows: T[];
  total: number;
}
