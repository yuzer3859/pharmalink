import { PrimaryRole } from '../enums';

/**
 * Who must use administrator MFA (Work 66): an account whose primary role is ADMIN or SUPER_ADMIN,
 * or that holds a **global** (no organisation) assignment of the PLATFORM-scoped ADMIN or SUPER_ADMIN
 * role. An organisation-scoped assignment never counts, even if a role with the same key existed in
 * that scope. The decision is made server-side from stored data, never from the portal a client
 * chose.
 */
export const PLATFORM_ADMIN_ROLE_KEYS = ['ADMIN', 'SUPER_ADMIN'] as const;

export function isPlatformAdminPrimaryRole(role: PrimaryRole | string): boolean {
  return (PLATFORM_ADMIN_ROLE_KEYS as readonly string[]).includes(role);
}
