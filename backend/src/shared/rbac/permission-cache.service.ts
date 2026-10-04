import { Injectable } from '@nestjs/common';

interface CacheEntry {
  permissions: string[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Per-user permission cache. Phase-0 implementation is an in-process TTL map; Module 01 will
 * swap the backing store to Redis (same interface) so permission checks stay O(1) and cache
 * invalidation propagates across instances on role/permission changes.
 */
@Injectable()
export class PermissionCacheService {
  private readonly store = new Map<string, CacheEntry>();

  get(userId: string): string[] | undefined {
    const entry = this.store.get(userId);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(userId);
      return undefined;
    }
    return entry.permissions;
  }

  set(userId: string, permissions: string[], ttlMs: number = DEFAULT_TTL_MS): void {
    this.store.set(userId, { permissions, expiresAt: Date.now() + ttlMs });
  }

  invalidate(userId: string): void {
    this.store.delete(userId);
  }

  clear(): void {
    this.store.clear();
  }
}
