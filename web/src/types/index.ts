// Domain types for PharmaLink Ethiopia operations console.

export type PortalKey = 'pharmacy' | 'admin' | 'superadmin' | 'finance';

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
  | 'verifications:view'
  | 'verifications:manage'
  | 'catalog:review'
  | 'finance:view'
  | 'finance:settle'
  | 'approvals:view'
  | 'finance:payout'
  | 'finance:refund'
  | 'support:impersonate'
  | 'disputes:manage'
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
  /** The public storefront name (Work 80). */
  displayName: string;
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

/** One inventory listing as `GET /admin/operations/inventory/listings` reports it. */
export interface AdminListing {
  listingId: string;
  pharmacyId: string;
  branchId: string;
  catalogProductId: string;
  isEnabled: boolean;
  storedSellable: number;
  computedSellable: number;
  customerPurchasable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminListingDetail extends AdminListing {
  reserved: number;
  unexpiredBatchCount: number;
  unexpiredBatchQuantity: number;
  storedMatchesComputed: boolean;
}

export interface AdminListingPage {
  items: AdminListing[];
  total: number;
  page: number;
  size: number;
}

export interface StatusCount {
  status: string;
  count: number;
}

/**
 * `GET /admin/analytics/overview`: six sections of counts and a stamp. Only `cod` is money (minor
 * units, ETB): the cash Module 08 accounts for, not revenue.
 */
export interface AnalyticsOverview {
  generatedAt: string;
  accounts: { total: number; byStatus: StatusCount[]; byPrimaryRole: Array<{ primaryRole: string; count: number }> };
  catalog: { products: { total: number; byStatus: StatusCount[] } };
  providers: {
    pharmacies: { total: number; eligible: number; byTransactingStatus: StatusCount[]; byLicenseStatus: StatusCount[] };
    branches: { total: number; active: number; inactive: number };
    listings: { total: number; enabled: number; disabled: number; inStock: number; outOfStock: number };
  };
  orders: { orders: { total: number; byStatus: StatusCount[] }; fulfillments: { total: number; byStatus: StatusCount[] } };
  delivery: {
    jobs: { total: number; byStatus: StatusCount[] };
    drivers: { total: number; dispatchable: number; byAvailability: Array<{ availability: string; count: number }> };
  };
  cod: {
    count: number;
    expectedAmount: number;
    collectedAmount: number;
    remittedAmount: number;
    outstandingCount: number;
    outstandingAmount: number;
    discrepancyCount: number;
  };
}

export type AccountStatus =
  | 'PENDING_VERIFICATION'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'DEACTIVATED'
  | 'DELETED'
  | 'PENDING_APPROVAL'
  | 'REJECTED';

export type PrimaryRole =
  | 'CUSTOMER'
  | 'PHARMACY_OWNER'
  | 'PHARMACY_MANAGER'
  | 'PHARMACIST'
  | 'CASHIER'
  | 'INVENTORY_STAFF'
  | 'DOCTOR'
  | 'DRIVER'
  | 'HOSPITAL_ADMIN'
  | 'DIAGNOSTIC_CENTER_ADMIN'
  | 'LAB_STAFF'
  | 'CUSTOMER_SUPPORT'
  | 'FINANCE_OFFICER'
  | 'ADMIN'
  | 'SUPER_ADMIN';

/** One account as `GET /admin/accounts` reports it. */
export interface AdminAccount {
  userId: string;
  phone: string | null;
  email: string | null;
  primaryRole: PrimaryRole;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAccountPage {
  items: AdminAccount[];
  total: number;
  page: number;
  size: number;
}

export interface RoleAssignment {
  assignmentId: string;
  roleKey: string;
  roleName: string;
  organizationId: string | null;
  createdAt: string;
}

export interface AdminAccountDetail extends AdminAccount {
  preferredLanguage: string;
  phoneVerifiedAt: string | null;
  emailVerifiedAt: string | null;
  faydaVerifiedAt: string | null;
  deletionRequestedAt: string | null;
  deletedAt: string | null;
  roles: RoleAssignment[];
}

export interface AccountStatusChange {
  userId: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  changedAt: string;
}

export interface RoleChange {
  assignmentId: string;
  userId: string;
  roleKey: string;
  organizationId: string | null;
  roles: Array<{ roleKey: string; organizationId: string | null }>;
}

/** One role of the catalogue (`GET /admin/roles`). */
export interface RoleCatalogueEntry {
  id: string;
  key: string;
  name: string;
  /** `PLATFORM` or an organisation scope. */
  scope: string;
  isSystem: boolean;
  description: string | null;
  permissions: string[];
}

export type VerificationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type VerificationType = 'FAYDA' | 'PHARMACY_LICENSE' | 'DRIVER_DOCS' | 'DOCTOR_LICENSE';

/** One request of `GET /admin/verifications`. */
export interface VerificationQueueItem {
  requestId: string;
  userId: string;
  organizationId: string | null;
  type: VerificationType;
  status: VerificationStatus;
  documentCount: number;
  submittedAt: string;
  reviewedAt: string | null;
  aging: { pendingSince: string | null; ageSeconds: number };
}

export interface VerificationQueuePage {
  items: VerificationQueueItem[];
  total: number;
  page: number;
  size: number;
}

export interface VerificationDetail extends VerificationQueueItem {
  /** Document references only: the API has no preview or download. */
  documents: Array<{ kind: string; storageRef: string; expiresAt: string | null }>;
  hasFaydaId: boolean;
  reviewerId: string | null;
  rejectReason: string | null;
  expiresAt: string | null;
  licenseNumber: string | null;
  applicant: { userId: string; primaryRole: string; accountStatus: string } | null;
}

export interface VerificationDecision {
  requestId: string;
  type: VerificationType;
  previousStatus: VerificationStatus;
  status: VerificationStatus;
  subjectUserId: string;
  organizationId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  licenseNumber: string | null;
}

export type ConfigValueType = 'BOOLEAN' | 'INTEGER' | 'DECIMAL' | 'STRING' | 'JSON';

/** One governable setting (`GET /admin/config`). */
export interface ConfigSetting {
  namespace: string;
  key: string;
  valueType: ConfigValueType;
  description: string;
  min: number | null;
  max: number | null;
  allowed: readonly string[] | null;
  effectiveValue: unknown;
  /** Where the effective value comes from, e.g. a published version or the code default. */
  source: string;
  activeVersion: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ConfigVersion {
  namespace: string;
  key: string;
  version: number;
  valueType: ConfigValueType;
  value: unknown;
  isActive: boolean;
  reason: string | null;
  updatedBy: string;
  createdAt: string;
}

export interface ConfigHistory {
  namespace: string;
  key: string;
  versions: ConfigVersion[];
}

export interface ConfigUpdate {
  config: ConfigVersion;
  previous: ConfigVersion | null;
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface FeatureFlagToggle {
  flag: FeatureFlag;
  created: boolean;
  changed: boolean;
}

export type CatalogProductStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'DEPRECATED' | 'DELISTED' | 'REJECTED';
export type CatalogProductType = 'MEDICINE' | 'HEALTH_PRODUCT';

/** One product of `GET /admin/catalog/review`. `price` is in minor units. */
export interface CatalogReviewItem {
  id: string;
  type: CatalogProductType;
  genericName: string | null;
  brandName: string | null;
  nameAm: string | null;
  nameEn: string | null;
  dosageForm: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  rxClassification: string | null;
  controlledSchedule: string;
  onlineSaleProhibited: boolean;
  manufacturerName: string | null;
  price: number | null;
  status: CatalogProductStatus;
  /** Target statuses the server will accept from this product's current status. */
  allowedTransitions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CatalogReviewPage {
  items: CatalogReviewItem[];
  total: number;
  page: number;
  size: number;
}

export interface CatalogReviewSummary {
  generatedAt: string;
  queue: {
    pendingReviewCount: number;
    pendingWithoutRecordedSubmission: number;
    oldestPendingSubmittedAt: string | null;
    oldestPendingAgeSeconds: number | null;
  };
  lifetimeTransitions: { approvals: number; rejections: number; resubmissions: number };
}

export interface CatalogHistory {
  productId: string;
  history: Array<{ from: string | null; to: string | null; occurredAt: string; reason: string | null }>;
}

export type FinancePaymentStatus =
  | 'INITIATED'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'SETTLED'
  | 'FAILED'
  | 'VOIDED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'EXPIRED';
export type FinancePaymentMethod = 'CARD' | 'TELEBIRR' | 'BANK_TRANSFER' | 'WALLET' | 'COD' | 'CROSS_BORDER';
export type RefundStatus = 'PENDING' | 'APPROVED' | 'COMPLETED' | 'FAILED';
export type SettlementStatus = 'DRAFT' | 'APPROVED' | 'PROCESSING' | 'PAID' | 'FAILED';
export type CodDisputeStatus = 'OPEN' | 'RESOLVED';

/** Money in this section is in integer minor units. */
export interface FinancePayment {
  paymentId: string;
  orderId: string;
  customerUserId: string;
  amount: number;
  currency: string;
  method: FinancePaymentMethod;
  status: FinancePaymentStatus;
  provider: string | null;
  providerRef: string | null;
  originalAmount: number | null;
  originalCurrency: string | null;
  fxRate: number | null;
  fxSource: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinancePaymentPage {
  items: FinancePayment[];
  total: number;
  page: number;
  size: number;
}

export interface FinanceRefund {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  type: string;
  destination: string;
  status: RefundStatus;
  providerRef: string | null;
  reason: string | null;
  createdAt: string;
  completedAt: string | null;
  approvedBy?: string | null;
}

export interface FinanceRefundPage {
  items: FinanceRefund[];
  total: number;
  page: number;
  size: number;
}

export interface FinancePaymentDetail {
  payment: FinancePayment;
  refunds: { capturedAmount: number; totalRefunded: number; remainingRefundable: number; refunds: FinanceRefund[] };
}

export interface FinanceOverview {
  generatedAt: string;
  payments: { byStatus: Array<{ currency: string; status: string; count: number; amount: number }> };
  refunds: { byStatus: Array<{ currency: string; status: string; count: number; amount: number }> };
  settlements: {
    byStatus: Array<{
      currency: string;
      status: string;
      count: number;
      providerPayableGross: number;
      refundClawback: number;
      netPayable: number;
      platformRevenue: number;
      promotionExpense: number;
      customerCashCollected: number;
    }>;
  };
  cod: {
    count: number;
    expectedAmount: number;
    collectedAmount: number;
    remittedAmount: number;
    outstandingCount: number;
    outstandingAmount: number;
    discrepancyCount: number;
  };
}

export interface Settlement {
  settlementId: string;
  statementRef: string;
  pharmacyId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  providerPayableGross: number;
  refundClawback: number;
  netPayable: number;
  platformRevenue: number;
  promotionExpense: number;
  customerCashCollected: number;
  lineCount: number;
  status: SettlementStatus;
  createdAt: string;
}

export interface SettlementPage {
  items: Settlement[];
  total: number;
  page: number;
  size: number;
}

export interface SettlementDetail extends Settlement {
  lines: Array<{
    ledgerReference: string;
    transactionType: string;
    orderId: string | null;
    occurredAt: string;
    providerPayableDelta: number;
    platformRevenueDelta: number;
    promotionExpenseDelta: number;
    customerCashDelta: number;
  }>;
}

export interface CodDispute {
  id: string;
  collectionId: string;
  reason: string;
  status: CodDisputeStatus;
  openedByUserId: string;
  openedAt: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface CodCollectionSummary {
  id: string;
  jobId: string;
  orderId: string;
  driverId: string;
  expectedAmount: number;
  collectedAmount: number;
  currency: string;
  status: string;
}

export interface CodDisputePage {
  items: Array<{ dispute: CodDispute; collection: CodCollectionSummary }>;
  total: number;
  page: number;
  size: number;
}

export interface CodDisputeDetail {
  dispute: CodDispute;
  collection: CodCollectionSummary & {
    method: string;
    collectedAt: string;
    remittedAt: string | null;
    reconciledAt: string | null;
    collectionVariance: number;
    remittanceVariance: number | null;
    hasDiscrepancy: boolean;
    isOutstanding: boolean;
    remittance: { remittedAmount: number; reference: string; remittedAt: string } | null;
    reconciliation: { outcome: string; reference: string | null; reconciledAt: string } | null;
    corrections: Array<{ id: string; type: string; reason: string; createdAt: string }>;
    disputes: CodDispute[];
  };
}

export interface CodDisputeResolution {
  dispute: CodDispute;
  collectionId: string;
  previousStatus: CodDisputeStatus;
  changed: boolean;
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

// ----- Maker-checker approvals (Work 82, GET/POST /admin/approvals) -----
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
export type ApprovalDecision = 'APPROVE' | 'REJECT';

export interface Approval {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  summary: string;
  reason: string | null;
  /** Effective: a PENDING request past its expiry reads EXPIRED. */
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  requiredPermission: string;
  requestedByUserId: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  executionResult: Record<string, unknown> | null;
  executionError: { code: string; message: string } | null;
  canDecide: boolean;
  isOwnRequest: boolean;
}

export interface ApprovalPage {
  items: Approval[];
  total: number;
  page: number;
  size: number;
}

export interface ApprovalAction {
  type: string;
  entityType: string;
  requiredPermission: string;
  requiresApproval: boolean;
}

// ----- Settlement approval and payout (Work 83, /admin/finance/settlements/:id/*) -----
export type PayoutRail = 'BANK_TRANSFER' | 'TELEBIRR';
export type PayoutBeneficiaryStatus = 'PENDING_VERIFICATION' | 'VERIFIED' | 'SUPERSEDED' | 'REVOKED';
export type PayoutAttemptStatus = 'PENDING' | 'PAID' | 'FAILED' | 'UNKNOWN';

export interface PayoutBeneficiary {
  id: string;
  pharmacyId: string;
  rail: PayoutRail;
  accountName: string;
  bankCode: string | null;
  accountIdentifierLast4: string;
  status: PayoutBeneficiaryStatus;
  createdByUserId: string;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  payableFrom: string | null;
  supersededAt: string | null;
  createdAt: string;
}

export interface PayoutAttempt {
  id: string;
  settlementId: string;
  beneficiaryId: string;
  reference: string;
  providerKey: string;
  amount: number;
  currency: string;
  status: PayoutAttemptStatus;
  providerReference: string | null;
  failureReason: string | null;
  initiatedByUserId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface SettlementPayoutView {
  settlement: {
    id: string;
    pharmacyId: string;
    currency: string;
    netPayable: number;
    status: SettlementStatus;
    approvedByUserId: string | null;
    approvedAt: string | null;
    paidAt: string | null;
  };
  attempts: PayoutAttempt[];
  beneficiary: PayoutBeneficiary | null;
}

/** A gated action's answer: run now (200) or waiting for a second officer (202). */
export type GatedOutcome =
  | { outcome: 'EXECUTED'; result: Record<string, unknown> }
  | { outcome: 'MAKER_CHECKER_PENDING'; approval: Approval };
