import { PrismaClient } from '@prisma/client';

/**
 * System roles (module-01 §5) and the representative permission catalog (§6.2). Extracted from
 * the seed script so integration tests can re-apply the exact same catalog they will run against
 * in development, instead of hand-rolling a divergent fixture.
 */
export const ROLES: Array<{ key: string; name: string; scope: 'PLATFORM' | 'ORG' | 'INDIVIDUAL' }> = [
  { key: 'CUSTOMER', name: 'Customer', scope: 'INDIVIDUAL' },
  { key: 'PHARMACY_OWNER', name: 'Pharmacy Owner', scope: 'ORG' },
  { key: 'PHARMACY_MANAGER', name: 'Pharmacy Manager', scope: 'ORG' },
  { key: 'PHARMACIST', name: 'Pharmacist', scope: 'ORG' },
  { key: 'CASHIER', name: 'Cashier', scope: 'ORG' },
  { key: 'INVENTORY_STAFF', name: 'Inventory Staff', scope: 'ORG' },
  { key: 'DRIVER', name: 'Driver', scope: 'INDIVIDUAL' },
  { key: 'DOCTOR', name: 'Doctor', scope: 'INDIVIDUAL' },
  { key: 'HOSPITAL_ADMIN', name: 'Hospital Administrator', scope: 'ORG' },
  { key: 'DIAGNOSTIC_CENTER_ADMIN', name: 'Diagnostic Center Administrator', scope: 'ORG' },
  { key: 'CUSTOMER_SUPPORT', name: 'Customer Support', scope: 'PLATFORM' },
  { key: 'FINANCE_OFFICER', name: 'Finance Officer', scope: 'PLATFORM' },
  { key: 'ADMIN', name: 'Admin', scope: 'PLATFORM' },
  { key: 'SUPER_ADMIN', name: 'Super Admin', scope: 'PLATFORM' },
];

export const PERMISSIONS: Array<{
  key: string;
  resource: string;
  action: string;
  scope?: 'own' | 'org' | 'any';
}> = [
  { key: 'auth:login', resource: 'auth', action: 'login' },
  { key: 'profile:read:own', resource: 'profile', action: 'read', scope: 'own' },
  { key: 'profile:update:own', resource: 'profile', action: 'update', scope: 'own' },
  { key: 'beneficiary:manage:own', resource: 'beneficiary', action: 'manage', scope: 'own' },
  // Module 02 — Profiles, Slice 1 (backend/docs/02-profiles-spec.md §7.2).
  { key: 'address:read:own', resource: 'address', action: 'read', scope: 'own' },
  { key: 'address:manage:own', resource: 'address', action: 'manage', scope: 'own' },
  { key: 'order:create:own', resource: 'order', action: 'create', scope: 'own' },
  { key: 'order:read:own', resource: 'order', action: 'read', scope: 'own' },
  { key: 'prescription:upload:own', resource: 'prescription', action: 'upload', scope: 'own' },
  { key: 'prescription:verify', resource: 'prescription', action: 'verify' },
  // Module 05 — Prescription & Matching, Slice 1 (backend/docs/05-prescription-matching-spec.md
  // §7.2).
  { key: 'prescription:read:own', resource: 'prescription', action: 'read', scope: 'own' },
  { key: 'matching:read:own', resource: 'matching', action: 'read', scope: 'own' },
  { key: 'matching:create:own', resource: 'matching', action: 'create', scope: 'own' },
  { key: 'catalog:manage:org', resource: 'catalog', action: 'manage', scope: 'org' },
  // Module 03 — Catalog, Slice 1 (backend/docs/03-catalog-spec.md §7.1). `catalog:read:any` is
  // reserved for a future authenticated-read variant only (§14.1) — it is seeded here but never
  // granted to a role and never attached to a route in this slice; public reads use a bare
  // `@Public()` and need no permission at all.
  { key: 'catalog:read:any', resource: 'catalog', action: 'read', scope: 'any' },
  { key: 'catalog:manage:any', resource: 'catalog', action: 'manage', scope: 'any' },
  { key: 'inventory:manage:org', resource: 'inventory', action: 'manage', scope: 'org' },
  // Module 04 — Pharmacy & Inventory, Slice 1 (backend/docs/04-pharmacy-inventory-spec.md §7.2).
  { key: 'pharmacy:manage:org', resource: 'pharmacy', action: 'manage', scope: 'org' },
  { key: 'pharmacy:register', resource: 'pharmacy', action: 'register' },
  // Reserved for a future authenticated availability read (§7.2) — seeded but never granted to
  // a role and never attached to a route in this slice; the public route uses `@Public()`.
  { key: 'availability:read:any', resource: 'availability', action: 'read', scope: 'any' },
  { key: 'order:read:org', resource: 'order', action: 'read', scope: 'org' },
  { key: 'order:fulfill:org', resource: 'order', action: 'fulfill', scope: 'org' },
  { key: 'payment:collect:org', resource: 'payment', action: 'collect', scope: 'org' },
  // Module 07 — Payment, HTTP slice (architecture/module-07-payment-wallet.md §9.1). The catalog
  // had no customer-facing payment permission: `payment:collect:org` is the CASHIER's COD
  // collection capability, not a customer authorizing their own order's payment.
  //
  // Capture and void are `:any` and granted to finance/admin rather than to a customer or a
  // pharmacy, because §9.1 describes them as internal saga operations. Their normal path is
  // Module 06 calling the exported inbound port in-process; the HTTP routes exist for
  // operational intervention, which is a finance responsibility.
  { key: 'payment:create:own', resource: 'payment', action: 'create', scope: 'own' },
  { key: 'payment:read:own', resource: 'payment', action: 'read', scope: 'own' },
  { key: 'payment:capture:any', resource: 'payment', action: 'capture', scope: 'any' },
  { key: 'payment:void:any', resource: 'payment', action: 'void', scope: 'any' },
  // Module 07 — Wallet (§9.4). One permission, `own`-scoped, for the two read routes. There is
  // deliberately no `wallet:spend` permission: §9.4 makes wallet spend internal to the checkout
  // saga, reached through `IWalletPort` in-process, so no route needs one — and a customer holding
  // a spend permission could move their own money outside a checkout. Top-up has no permission
  // either while it has no route.
  { key: 'wallet:read:own', resource: 'wallet', action: 'read', scope: 'own' },
  // Module 07 — Coupons (§9.5 — "Admin CRUD /admin/finance/coupons — `coupon:manage` (Admin)").
  // Deliberately not folded into a broader `finance:*` permission: §9.5 names this exact key, and
  // the finance permissions are the Finance Officer's payout/refund authority, which is a
  // different job from curating promotions. Unscoped, like `prescription:verify` and
  // `pharmacy:register`, because a coupon belongs to the platform rather than to an owner.
  { key: 'coupon:manage', resource: 'coupon', action: 'manage' },
  { key: 'staff:manage:org', resource: 'staff', action: 'manage', scope: 'org' },
  { key: 'settlement:read:org', resource: 'settlement', action: 'read', scope: 'org' },
  { key: 'delivery:accept:own', resource: 'delivery', action: 'accept', scope: 'own' },
  { key: 'delivery:update:own', resource: 'delivery', action: 'update', scope: 'own' },
  // The read counterpart of the two above, added by the driver-earnings work (module-08 §3.5
  // F-ERN-02, `GET /driver/earnings`). `DRIVER` held only write verbs on `delivery`, and
  // guarding a read with `delivery:update:own` would make this catalogue misdescribe the route.
  // Narrow on purpose: `own` scope, granted only to `DRIVER`, and it authorizes nothing beyond
  // reading delivery records the caller already owns — not a finance permission, which the
  // Module 07 settlement work will define when it has a consumer for one.
  { key: 'delivery:read:own', resource: 'delivery', action: 'read', scope: 'own' },
  { key: 'appointment:manage:own', resource: 'appointment', action: 'manage', scope: 'own' },
  { key: 'hospital:manage:org', resource: 'hospital', action: 'manage', scope: 'org' },
  { key: 'lab:manage:org', resource: 'lab', action: 'manage', scope: 'org' },
  { key: 'labresult:release:org', resource: 'labresult', action: 'release', scope: 'org' },
  { key: 'support:account:read', resource: 'support', action: 'account_read' },
  { key: 'support:recovery:assist', resource: 'support', action: 'recovery_assist' },
  { key: 'finance:refund:any', resource: 'finance', action: 'refund', scope: 'any' },
  { key: 'finance:settlement:any', resource: 'finance', action: 'settlement', scope: 'any' },
  { key: 'finance:report:any', resource: 'finance', action: 'report', scope: 'any' },
  { key: 'user:suspend:any', resource: 'user', action: 'suspend', scope: 'any' },
  { key: 'user:reactivate:any', resource: 'user', action: 'reactivate', scope: 'any' },
  { key: 'provider:verify:any', resource: 'provider', action: 'verify', scope: 'any' },
  { key: 'verification:queue:read', resource: 'verification', action: 'queue_read' },
  { key: 'review:moderate:any', resource: 'review', action: 'moderate', scope: 'any' },
  // §6.2 lists rbac management as "Super Admin (Admin: read-only)". A single `rbac:manage` key
  // cannot express that split, so reads are carved out into their own permission.
  { key: 'rbac:read', resource: 'rbac', action: 'read' },
  { key: 'rbac:manage', resource: 'rbac', action: 'manage' },
  { key: 'config:manage:global', resource: 'config', action: 'manage_global' },
  { key: 'admin:manage', resource: 'admin', action: 'manage' },
  { key: 'audit:read:any', resource: 'audit', action: 'read', scope: 'any' },
  // Module 16 — operational analytics (architecture/module-16-admin-platform.md §9.7 names
  // `analytics:read` for `/admin/analytics/*`). Added by Work 08 because no existing read key
  // spans accounts, catalogue, providers, orders and delivery at once: every other read
  // permission is one resource's (`rbac:read`, `audit:read:any`, `verification:queue:read`), and
  // `finance:report:any` is the finance desk's, not an operations dashboard's.
  { key: 'analytics:read', resource: 'analytics', action: 'read' },
];

/** Role -> permission keys, mirroring the "Roles" column of module-01 §6.2. */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  CUSTOMER: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'beneficiary:manage:own',
    'order:create:own',
    'order:read:own',
    'prescription:upload:own',
    // Module 05 — Prescription & Matching, Slice 1 (§7.2).
    'prescription:read:own',
    'matching:read:own',
    'matching:create:own',
    'address:read:own',
    'address:manage:own',
    // Module 07 — Payment, HTTP slice (§9.1): a customer pays for, and reads, their own order's
    // payment. Capture and void are deliberately not granted here.
    'payment:create:own',
    'payment:read:own',
    // Module 07 — Wallet (§9.4): a customer reads their own wallet and its history. Spend stays
    // internal to the checkout saga and needs no grant.
    'wallet:read:own',
  ],
  PHARMACY_OWNER: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'catalog:manage:org',
    'inventory:manage:org',
    'order:read:org',
    'order:fulfill:org',
    'staff:manage:org',
    'settlement:read:org',
    // Module 04 — Pharmacy & Inventory, Slice 1 (§7.2): owner-level only, not shared with
    // managers/inventory staff.
    'pharmacy:manage:org',
    'pharmacy:register',
  ],
  PHARMACY_MANAGER: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'catalog:manage:org',
    'inventory:manage:org',
    'order:read:org',
    'order:fulfill:org',
    'staff:manage:org',
  ],
  PHARMACIST: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'prescription:verify',
    'order:read:org',
    'order:fulfill:org',
  ],
  CASHIER: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'order:read:org',
    'payment:collect:org',
  ],
  INVENTORY_STAFF: ['auth:login', 'profile:read:own', 'profile:update:own', 'inventory:manage:org'],
  DRIVER: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'delivery:accept:own',
    'delivery:update:own',
    'delivery:read:own',
  ],
  DOCTOR: ['auth:login', 'profile:read:own', 'profile:update:own', 'appointment:manage:own'],
  HOSPITAL_ADMIN: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'hospital:manage:org',
    'staff:manage:org',
  ],
  DIAGNOSTIC_CENTER_ADMIN: [
    'auth:login',
    'profile:read:own',
    'profile:update:own',
    'lab:manage:org',
    'labresult:release:org',
  ],
  CUSTOMER_SUPPORT: [
    'auth:login',
    'profile:read:own',
    'support:account:read',
    'support:recovery:assist',
  ],
  FINANCE_OFFICER: [
    'auth:login',
    'profile:read:own',
    // Module 07 — Payment, HTTP slice (§9.1).
    'payment:capture:any',
    'payment:void:any',
    'finance:refund:any',
    'finance:settlement:any',
    'finance:report:any',
  ],
  ADMIN: [
    'auth:login',
    'profile:read:own',
    'user:suspend:any',
    'user:reactivate:any',
    'provider:verify:any',
    'verification:queue:read',
    'review:moderate:any',
    'finance:report:any',
    'rbac:read',
    'audit:read:any',
    // Module 16 — operational analytics (Work 08). The dashboard is the administrator's; the
    // finance officer keeps `finance:report:any` and its own overview.
    'analytics:read',
    // Module 03 — Catalog, Slice 1 (backend/docs/03-catalog-spec.md §7.1).
    'catalog:manage:any',
    // Module 07 — Payment, HTTP slice (§9.1).
    'payment:capture:any',
    'payment:void:any',
    // Module 07 — Coupons (§9.5): the design assigns coupon curation to Admin, not to the
    // Finance Officer.
    'coupon:manage',
  ],
  SUPER_ADMIN: ['*'],
};

/** Super-admin wildcard, matched by the PermissionsGuard's segment matcher. */
export const WILDCARD_PERMISSION = {
  key: '*',
  resource: '*',
  action: '*',
  description: 'Super-admin wildcard',
};

/**
 * Applies the role/permission catalog. Idempotent — safe to re-run against an existing database
 * and safe to call repeatedly between integration tests.
 */
export async function seedRbacCatalog(prisma: PrismaClient): Promise<void> {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { key: role.key },
      create: { key: role.key, name: role.name, scope: role.scope, isSystem: true },
      update: { name: role.name, scope: role.scope },
    });
  }

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: permission,
    });
  }

  await prisma.permission.upsert({
    where: { key: WILDCARD_PERMISSION.key },
    create: WILDCARD_PERMISSION,
    update: {},
  });

  const roles = await prisma.role.findMany();
  const permissions = await prisma.permission.findMany();
  const roleByKey = new Map(roles.map((r) => [r.key, r.id]));
  const permissionByKey = new Map(permissions.map((p) => [p.key, p.id]));

  for (const [roleKey, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleByKey.get(roleKey);
    if (!roleId) continue;

    const permissionIds = permissionKeys
      .map((key) => permissionByKey.get(key))
      .filter((id): id is string => Boolean(id));

    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    });
  }
}
