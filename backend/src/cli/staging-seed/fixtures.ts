/**
 * The staging verification baseline (Work 80): every account, organisation, product and money
 * scenario the staging seed creates, by a stable natural key. The seed, its e2e spec, the admin
 * walk script and the walkthrough checklist all read these names, so they agree on what exists.
 *
 * Nothing here is a credential. Fixture accounts are created without a password; the two that a
 * person signs in with (ADMIN, FINANCE_OFFICER) get theirs from the owner through
 * `npm run staging:set-password`, typed at the keyboard. Every address is on the reserved `.test`
 * domain, so no notification can reach a real inbox; customers, drivers and the doctor have phone
 * numbers only, and SMS has no provider on staging.
 */
/**
 * The admin walk runs twice, once signed in as Admin and once as Super Admin. Every action that
 * consumes its fixture (approve, reject, activate, resolve, submit) has one fixture per round;
 * reversible actions (suspend and reinstate, assign and revoke, toggle, publish and roll back)
 * share one.
 */
export const WALK_ROUNDS = ['admin', 'superAdmin'] as const;
export type WalkRound = (typeof WALK_ROUNDS)[number];

export const FIXTURE_EMAIL_DOMAIN = 'staging.pharmalink.test';

const email = (local: string) => `${local}@${FIXTURE_EMAIL_DOMAIN}`;

export interface FixtureAccount {
  key: string;
  /** The walk round whose one-shot actions use it; null for shared fixtures. */
  round: WalkRound | null;
  email: string | null;
  phone: string | null;
  primaryRole: 'ADMIN' | 'FINANCE_OFFICER' | 'CUSTOMER' | 'DRIVER' | 'DOCTOR';
  /** Platform role granted to the account; `null` for none. */
  roleKey: string | null;
  /** Whether the owner sets a password for it with `staging:set-password`. */
  signIn: boolean;
  purpose: string;
}

export const FIXTURE_ACCOUNTS: readonly FixtureAccount[] = [
  {
    key: 'admin', round: null,
    email: email('admin'),
    phone: null,
    primaryRole: 'ADMIN',
    roleKey: 'ADMIN',
    signIn: true,
    purpose: 'The Admin the owner signs in as (password and authenticator set by the owner)',
  },
  {
    key: 'finance', round: null,
    email: email('finance'),
    phone: null,
    primaryRole: 'FINANCE_OFFICER',
    roleKey: 'FINANCE_OFFICER',
    signIn: true,
    purpose: 'The Finance Officer the owner signs in as (password set by the owner)',
  },
  {
    key: 'financeChecker', round: null,
    email: email('finance.checker'),
    phone: null,
    primaryRole: 'FINANCE_OFFICER',
    roleKey: 'FINANCE_OFFICER',
    signIn: true,
    purpose: 'The second Finance Officer, who decides maker-checker requests (Work 83; password set by the owner)',
  },
  {
    key: 'operator', round: null,
    email: email('seed.operator'),
    phone: null,
    primaryRole: 'ADMIN',
    roleKey: 'ADMIN',
    signIn: false,
    purpose: 'Recorded as the actor of the decisions the seed makes; has no password and cannot sign in',
  },
  {
    key: 'walkTarget', round: null,
    email: null,
    phone: '+251910000101',
    primaryRole: 'CUSTOMER',
    roleKey: null,
    signIn: false,
    purpose: 'Account the walk suspends, reinstates, and assigns and revokes a role on',
  },
  {
    key: 'customerOrders', round: null,
    email: null,
    phone: '+251910000102',
    primaryRole: 'CUSTOMER',
    roleKey: null,
    signIn: false,
    purpose: 'Customer of the seeded orders and payments',
  },
  {
    key: 'customerFayda', round: 'admin',
    email: null,
    phone: '+251910000103',
    primaryRole: 'CUSTOMER',
    roleKey: null,
    signIn: false,
    purpose: 'Holds the pending FAYDA verification',
  },
  {
    key: 'driverCod', round: null,
    email: null,
    phone: '+251910000104',
    primaryRole: 'DRIVER',
    roleKey: 'DRIVER',
    signIn: false,
    purpose: 'Approved driver who delivered the COD orders',
  },
  {
    key: 'driverPending', round: 'admin',
    email: null,
    phone: '+251910000105',
    primaryRole: 'DRIVER',
    roleKey: 'DRIVER',
    signIn: false,
    purpose: 'Holds the pending DRIVER_DOCS verification',
  },
  {
    key: 'doctorPending', round: 'admin',
    email: null,
    phone: '+251910000106',
    primaryRole: 'DOCTOR',
    roleKey: null,
    signIn: false,
    purpose: 'Holds the pending DOCTOR_LICENSE verification',
  },
  // Super Admin walk round: the same one-shot verification holders, with their own numbers.
  { key: 'customerFaydaSuperAdmin', round: 'superAdmin', email: null, phone: '+251910000203', primaryRole: 'CUSTOMER', roleKey: null, signIn: false, purpose: 'Holds the pending FAYDA verification (Super Admin walk)' },
  { key: 'driverPendingSuperAdmin', round: 'superAdmin', email: null, phone: '+251910000205', primaryRole: 'DRIVER', roleKey: 'DRIVER', signIn: false, purpose: 'Holds the pending DRIVER_DOCS verification (Super Admin walk)' },
  { key: 'doctorPendingSuperAdmin', round: 'superAdmin', email: null, phone: '+251910000206', primaryRole: 'DOCTOR', roleKey: null, signIn: false, purpose: 'Holds the pending DOCTOR_LICENSE verification (Super Admin walk)' },
];

export const SIGN_IN_FIXTURE_EMAILS: readonly string[] = FIXTURE_ACCOUNTS.filter((a) => a.signIn).map((a) => a.email!);

/** One organisation per lifecycle state the admin pages show, plus one per action the walk takes. */
export interface FixtureOrganization {
  key: string;
  /** The walk round whose one-shot actions use it; null for shared fixtures. */
  round: WalkRound | null;
  legalName: string;
  ownerEmail: string;
  /** What the seed leaves it as. */
  outcome:
    | 'ACTIVE_TRANSACTING'
    | 'ACTIVE_NOT_ACTIVATED'
    | 'PENDING_APPROVAL'
    | 'REJECTED'
    | 'SUSPENDED';
  /** Licence number used when the seed approves its licence. */
  licenseNumber: string | null;
  branch: { name: string; city: string; subcity: string; addressLine: string; lat: number; lng: number } | null;
  purpose: string;
}

export const FIXTURE_ORGANIZATIONS: readonly FixtureOrganization[] = [
  {
    key: 'transacting', round: null,
    legalName: 'Seed Bole Pharmacy',
    ownerEmail: email('owner.bole'),
    outcome: 'ACTIVE_TRANSACTING',
    licenseNumber: 'STG-LIC-0001',
    branch: { name: 'Bole Main', city: 'Addis Ababa', subcity: 'Bole', addressLine: 'Africa Avenue', lat: 9.0108, lng: 38.7613 },
    purpose: 'Approved, activated and transacting: the pharmacy of every seeded order, payment, settlement and COD collection',
  },
  {
    key: 'awaitingActivation', round: 'admin',
    legalName: 'Seed Piassa Pharmacy',
    ownerEmail: email('owner.piassa'),
    outcome: 'ACTIVE_NOT_ACTIVATED',
    licenseNumber: 'STG-LIC-0002',
    branch: { name: 'Piassa Branch', city: 'Addis Ababa', subcity: 'Arada', addressLine: 'Churchill Avenue', lat: 9.0349, lng: 38.7516 },
    purpose: 'Licence approved and organisation active, pharmacy not yet activated: the walk activates it',
  },
  {
    key: 'pendingApprove', round: 'admin',
    legalName: 'Seed Kazanchis Pharmacy',
    ownerEmail: email('owner.kazanchis'),
    outcome: 'PENDING_APPROVAL',
    licenseNumber: null,
    branch: null,
    purpose: 'Pending licence verification: the walk approves it',
  },
  {
    key: 'pendingReject', round: 'admin',
    legalName: 'Seed Megenagna Pharmacy',
    ownerEmail: email('owner.megenagna'),
    outcome: 'PENDING_APPROVAL',
    licenseNumber: null,
    branch: null,
    purpose: 'Pending licence verification: the walk rejects it',
  },
  {
    key: 'rejected', round: null,
    legalName: 'Seed Merkato Pharmacy',
    ownerEmail: email('owner.merkato'),
    outcome: 'REJECTED',
    licenseNumber: null,
    branch: null,
    purpose: 'Licence rejected by the seed operator',
  },
  {
    key: 'suspended', round: null,
    legalName: 'Seed Sarbet Pharmacy',
    ownerEmail: email('owner.sarbet'),
    outcome: 'SUSPENDED',
    licenseNumber: 'STG-LIC-0006',
    branch: null,
    purpose:
      'Approved, then set to SUSPENDED directly: no backend action suspends an organisation yet, so this state is fixture data only',
  },
  // Super Admin walk round.
  {
    key: 'awaitingActivationSuperAdmin',
    round: 'superAdmin',
    legalName: 'Seed Lideta Pharmacy',
    ownerEmail: email('owner.lideta'),
    outcome: 'ACTIVE_NOT_ACTIVATED',
    licenseNumber: 'STG-LIC-0012',
    branch: { name: 'Lideta Branch', city: 'Addis Ababa', subcity: 'Lideta', addressLine: 'Ras Mekonnen Street', lat: 9.0107, lng: 38.7376 },
    purpose: 'Licence approved and organisation active, pharmacy not yet activated: the Super Admin walk activates it',
  },
  {
    key: 'pendingApproveSuperAdmin',
    round: 'superAdmin',
    legalName: 'Seed Gerji Pharmacy',
    ownerEmail: email('owner.gerji'),
    outcome: 'PENDING_APPROVAL',
    licenseNumber: null,
    branch: null,
    purpose: 'Pending licence verification: the Super Admin walk approves it',
  },
  {
    key: 'pendingRejectSuperAdmin',
    round: 'superAdmin',
    legalName: 'Seed CMC Pharmacy',
    ownerEmail: email('owner.cmc'),
    outcome: 'PENDING_APPROVAL',
    licenseNumber: null,
    branch: null,
    purpose: 'Pending licence verification: the Super Admin walk rejects it',
  },
];

/** Products by the status the seed leaves them in. Names are unique; the seed finds them by `nameEn`. */
export interface FixtureProduct {
  key: string;
  /** The walk round whose one-shot actions use it; null for shared fixtures. */
  round: WalkRound | null;
  nameEn: string;
  genericName: string;
  strength: { value: number; unit: string };
  dosageForm: string;
  outcome: 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'DEPRECATED' | 'DELISTED';
  purpose: string;
}

export const FIXTURE_PRODUCTS: readonly FixtureProduct[] = [
  { key: 'draft', round: 'admin', nameEn: 'Seed Paracetamol 500 mg tablet', genericName: 'Paracetamol', strength: { value: 500, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'DRAFT', purpose: 'Draft: the walk submits it for review' },
  { key: 'pendingApprove', round: 'admin', nameEn: 'Seed Ibuprofen 400 mg tablet', genericName: 'Ibuprofen', strength: { value: 400, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'PENDING_REVIEW', purpose: 'Waiting for review: the walk approves it' },
  { key: 'pendingReject', round: 'admin', nameEn: 'Seed Cetirizine 10 mg tablet', genericName: 'Cetirizine', strength: { value: 10, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'PENDING_REVIEW', purpose: 'Waiting for review: the walk rejects it' },
  { key: 'pendingStays', round: null, nameEn: 'Seed Omeprazole 20 mg capsule', genericName: 'Omeprazole', strength: { value: 20, unit: 'mg' }, dosageForm: 'CAPSULE', outcome: 'PENDING_REVIEW', purpose: 'Waiting for review: left in the queue' },
  { key: 'active', round: null, nameEn: 'Seed Amoxicillin 500 mg capsule', genericName: 'Amoxicillin', strength: { value: 500, unit: 'mg' }, dosageForm: 'CAPSULE', outcome: 'ACTIVE', purpose: 'Approved: the product on every seeded order line' },
  { key: 'rejected', round: 'admin', nameEn: 'Seed Metformin 850 mg tablet', genericName: 'Metformin', strength: { value: 850, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'REJECTED', purpose: 'Rejected by the seed operator: the walk returns it to review' },
  { key: 'deprecated', round: null, nameEn: 'Seed Ranitidine 150 mg tablet', genericName: 'Ranitidine', strength: { value: 150, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'DEPRECATED', purpose: 'Deprecated after approval' },
  { key: 'delisted', round: null, nameEn: 'Seed Codeine 30 mg tablet', genericName: 'Codeine', strength: { value: 30, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'DELISTED', purpose: 'Delisted after approval' },
  // Super Admin walk round: different strengths, so the catalogue's duplicate check keeps them apart.
  { key: 'draftSuperAdmin', round: 'superAdmin', nameEn: 'Seed Paracetamol 650 mg tablet', genericName: 'Paracetamol', strength: { value: 650, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'DRAFT', purpose: 'Draft: the Super Admin walk submits it for review' },
  { key: 'pendingApproveSuperAdmin', round: 'superAdmin', nameEn: 'Seed Ibuprofen 200 mg tablet', genericName: 'Ibuprofen', strength: { value: 200, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'PENDING_REVIEW', purpose: 'Waiting for review: the Super Admin walk approves it' },
  { key: 'pendingRejectSuperAdmin', round: 'superAdmin', nameEn: 'Seed Cetirizine 5 mg tablet', genericName: 'Cetirizine', strength: { value: 5, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'PENDING_REVIEW', purpose: 'Waiting for review: the Super Admin walk rejects it' },
  { key: 'rejectedSuperAdmin', round: 'superAdmin', nameEn: 'Seed Metformin 1000 mg tablet', genericName: 'Metformin', strength: { value: 1000, unit: 'mg' }, dosageForm: 'TABLET', outcome: 'REJECTED', purpose: 'Rejected by the seed operator: the Super Admin walk returns it to review' },
];

/** Money and delivery scenarios, all at the transacting pharmacy. Amounts are minor units (santim). */
export interface FixtureOrder {
  key: string;
  /** The walk round whose one-shot actions use it; null for shared fixtures. */
  round: WalkRound | null;
  orderNumber: string;
  grandTotal: number;
  isCod: boolean;
  /** For COD orders: what the driver declares collected. */
  codCollected?: number;
  /** For gateway orders: the refund the finance officer issues (`null` = full refund). */
  refund?: { amount: number | null; reason: string };
  capture?: boolean;
  purpose: string;
}

export const FIXTURE_ORDERS: readonly FixtureOrder[] = [
  { key: 'captured', round: null, orderNumber: 'STG-SEED-0001', grandTotal: 48_000, isCod: false, capture: true, purpose: 'Telebirr payment, captured' },
  { key: 'partialRefund', round: null, orderNumber: 'STG-SEED-0002', grandTotal: 36_500, isCod: false, capture: true, refund: { amount: 10_000, reason: 'Seed: one item out of stock' }, purpose: 'Captured, then partially refunded' },
  { key: 'fullRefund', round: null, orderNumber: 'STG-SEED-0003', grandTotal: 22_000, isCod: false, capture: true, refund: { amount: null, reason: 'Seed: order cancelled by the customer' }, purpose: 'Captured, then fully refunded' },
  { key: 'authorizedOnly', round: null, orderNumber: 'STG-SEED-0004', grandTotal: 15_750, isCod: false, capture: false, purpose: 'Authorised, not yet captured' },
  { key: 'codDisputed', round: 'admin', orderNumber: 'STG-SEED-0005', grandTotal: 24_500, isCod: true, codCollected: 20_000, purpose: 'Cash on delivery, 4,500 short, with an open dispute: the walk resolves it' },
  { key: 'codExact', round: null, orderNumber: 'STG-SEED-0006', grandTotal: 18_000, isCod: true, codCollected: 18_000, purpose: 'Cash on delivery, collected in full' },
  { key: 'codDisputedSuperAdmin', round: 'superAdmin', orderNumber: 'STG-SEED-0007', grandTotal: 30_000, isCod: true, codCollected: 27_500, purpose: 'Cash on delivery, 2,500 short, with an open dispute: the Super Admin walk resolves it' },
];

export const FIXTURE_DISPUTE_REASON = 'Seed: short by 45.00 ETB at the cash desk.';
/** A feature flag the walk toggles, created by the seed so the walk never flips a real one. */
export const FIXTURE_FEATURE_FLAG = 'staging_walk_demo';
/** A well-formed Fayda number the mock provider accepts (12 digits). */
export const FIXTURE_FAYDA_ID = '100000000080';
/** MEDICINE products must name a manufacturer; every seeded product uses this one. */
export const FIXTURE_MANUFACTURER = 'Seed Addis Pharmaceuticals';
