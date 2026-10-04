import { Inject, Injectable } from '@nestjs/common';
import {
  IPermissionCacheInvalidator,
  PERMISSION_CACHE_INVALIDATOR,
} from '../ports/permission-cache.port';
import { IPermVersionStore, PERM_VERSION_STORE } from '../ports/perm-version.port';
import { IRbacRepository, RBAC_REPOSITORY } from '../../domain/repositories/rbac.repository';

/**
 * Propagates an authorization change (module-01 §6.1, §8 "Permission versioning"): bump
 * `permVersion` so outstanding access tokens are rejected by JwtAuthGuard, then evict both
 * caches so the next request resolves the new truth. Order matters — the database is updated
 * before eviction so a concurrent reader can never repopulate a cache with the old value.
 */
@Injectable()
export class PermissionChangeService {
  constructor(
    @Inject(RBAC_REPOSITORY) private readonly rbac: IRbacRepository,
    @Inject(PERMISSION_CACHE_INVALIDATOR)
    private readonly cache: IPermissionCacheInvalidator,
    @Inject(PERM_VERSION_STORE) private readonly permVersions: IPermVersionStore,
  ) {}

  async propagate(userIds: string[]): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      return;
    }
    await this.rbac.bumpPermVersion(unique);
    await this.cache.invalidate(unique);
    this.permVersions.invalidate(unique);
  }
}
