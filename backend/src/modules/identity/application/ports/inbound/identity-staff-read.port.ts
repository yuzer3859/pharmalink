export const IDENTITY_STAFF_READ_PORT = Symbol('IDENTITY_STAFF_READ_PORT');

/** The platform roles that make an account staff (module-16 Work 88). */
export const STAFF_ROLE_KEYS = ['SUPER_ADMIN', 'ADMIN', 'FINANCE_OFFICER', 'CUSTOMER_SUPPORT'] as const;
export type StaffRoleKey = (typeof STAFF_ROLE_KEYS)[number];

export interface StaffMemberView {
  userId: string;
  email: string | null;
  phone: string | null;
  status: string;
  /** The platform roles held, sorted; never empty. */
  roles: StaffRoleKey[];
}

/**
 * Module 01's inbound read for Module 16's admin activity monitoring (Work 88,
 * backend/docs/admin-activity.md): who holds a platform role. Staff are identified by role
 * assignment, not `primaryRole`, because staff accounts often start as customers. Read-only.
 */
export interface IIdentityStaffReadPort {
  listStaff(): Promise<StaffMemberView[]>;
}
