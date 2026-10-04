export const PERMISSION_CACHE_INVALIDATOR = Symbol('PERMISSION_CACHE_INVALIDATOR');

/**
 * Lets RBAC use cases evict cached effective-permission sets after a role/permission change
 * (module-01 §6.1, §16). The application layer stays unaware of the cache implementation, which
 * is an in-process TTL map today and Redis later.
 */
export interface IPermissionCacheInvalidator {
  invalidate(userIds: string[]): Promise<void>;
}
