import { Global, Module } from '@nestjs/common';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionsGuard } from './permissions.guard';

/**
 * Provides RBAC building blocks globally. PermissionsGuard is provided (not registered as a
 * global APP_GUARD here) so each module/route opts in; Module 01 will pair it with the auth
 * guard and, if desired, register both globally.
 */
@Global()
@Module({
  providers: [PermissionCacheService, PermissionsGuard],
  exports: [PermissionCacheService, PermissionsGuard],
})
export class RbacModule {}
