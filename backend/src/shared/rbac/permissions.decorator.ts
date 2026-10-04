import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Declares the permissions required to invoke a route/handler. The PermissionsGuard reads this
 * metadata and checks the authenticated principal's granted permissions against it.
 *
 * @example @RequirePermissions('orders:read:own')
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
