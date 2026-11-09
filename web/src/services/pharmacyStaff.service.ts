import { authService, type SessionRequest } from './auth.service';

/**
 * Work 114: the pharmacy's staff on the real API (Work 113, module-04 §9.2). `staff:manage:org`
 * (the owner or a manager). Adding staff gives an **existing** PharmaLink account a staff role by
 * e-mail; the person signs up first. The owner role is never given or taken, and nobody changes
 * their own roles.
 */

export interface StaffRoleGrant {
  roleKey: string;
  roleName: string;
  assignedAt: string;
}

export interface StaffMember {
  userId: string;
  email: string | null;
  phone: string | null;
  status: string;
  roles: StaffRoleGrant[];
}

export interface AssignableRole {
  key: string;
  name: string;
  description: string | null;
  permissionKeys: string[];
}

export interface StaffList {
  organizationId: string;
  items: StaffMember[];
  assignableRoles: AssignableRole[];
}

/** Account housekeeping every signed-in user has; not worth listing per role. */
const BASELINE = new Set(['auth:login', 'profile:read:own', 'profile:update:own', 'notification:read:own', 'notification:manage:own']);

const LABELS: Record<string, string> = {
  'catalog:manage:org': 'Propose catalogue products',
  'inventory:manage:org': 'Manage inventory and stock',
  'order:read:org': 'See the pharmacy’s orders',
  'order:fulfill:org': 'Accept, prepare and hand over orders',
  'staff:manage:org': 'Manage staff',
  'prescription:verify': 'Review and approve prescriptions',
  'payment:collect:org': 'Record payments collected at the counter',
  'settlement:read:org': 'See settlement statements',
  'pharmacy:manage:org': 'Manage the pharmacy profile and branches',
};

/** What a role allows, in plain words, without the account basics. Unknown keys show as they are. */
export function describePermissions(keys: string[]): string[] {
  return keys.filter((k) => !BASELINE.has(k)).map((k) => LABELS[k] ?? k);
}

/** The owner's role is the organisation's own; it is shown, never offered or removed. */
export const OWNER_ROLE = 'PHARMACY_OWNER';

export function emailProblem(email: string): string | null {
  const value = email.trim();
  if (!value) return 'Enter their e-mail address.';
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'That does not look like an e-mail address.';
  return null;
}

/** Whether the signed-in user may take this role from this member (the server's own rule). */
export function canRemoveRole(memberUserId: string, roleKey: string, me: string | undefined, assignable: AssignableRole[]): boolean {
  return memberUserId !== me && roleKey !== OWNER_ROLE && assignable.some((r) => r.key === roleKey);
}

export function createPharmacyStaffService(request: SessionRequest) {
  return {
    list(): Promise<StaffList> {
      return request<StaffList>('/pharmacy/staff', { method: 'GET' });
    },
    add(email: string, roleKey: string): Promise<unknown> {
      return request('/pharmacy/staff', { method: 'POST', body: { email: email.trim(), roleKey } });
    },
    removeRole(userId: string, roleKey: string): Promise<unknown> {
      return request(`/pharmacy/staff/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleKey)}`, { method: 'DELETE' });
    },
  };
}

export const pharmacyStaffService = createPharmacyStaffService(authService.request);
