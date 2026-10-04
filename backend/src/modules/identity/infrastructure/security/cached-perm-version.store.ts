import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { IPermVersionStore } from '../../application/ports/perm-version.port';

interface CacheEntry {
  version: number | null;
  expiresAt: number;
}

/**
 * The TTL bounds how long a stale entry can survive if an invalidation is ever missed (e.g. a
 * change applied by another instance before this cache moves to Redis — module-01 §16).
 */
const TTL_MS = 30_000;

/**
 * In-process, TTL-bounded `permVersion` cache backed by Postgres. Keeps the authorization
 * check on the hot path to one DB read per user per TTL window instead of one per request.
 * Swap the backing store for Redis alongside PermissionCacheService.
 */
@Injectable()
export class CachedPermVersionStore implements IPermVersionStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(userId: string): Promise<number | null> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.version;
    }

    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { permVersion: true },
    });
    const version = row?.permVersion ?? null;
    this.cache.set(userId, { version, expiresAt: Date.now() + TTL_MS });
    return version;
  }

  invalidate(userIds: string[]): void {
    for (const userId of userIds) {
      this.cache.delete(userId);
    }
  }

  /** Drops every cached entry. Mirrors PermissionCacheService.clear(). */
  clear(): void {
    this.cache.clear();
  }
}
