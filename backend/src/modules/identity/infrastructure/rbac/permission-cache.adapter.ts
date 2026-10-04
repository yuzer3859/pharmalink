import { Injectable } from '@nestjs/common';
import { PermissionCacheService } from '../../../../shared/rbac/permission-cache.service';
import { IPermissionCacheInvalidator } from '../../application/ports/permission-cache.port';

/**
 * Adapts the shared PermissionCacheService to the application-layer invalidation port
 * (module-01 §12). When the cache moves to Redis, only this adapter changes.
 */
@Injectable()
export class PermissionCacheAdapter implements IPermissionCacheInvalidator {
  constructor(private readonly cache: PermissionCacheService) {}

  async invalidate(userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      this.cache.invalidate(userId);
    }
  }
}
