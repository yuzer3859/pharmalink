import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { AuthState, IPermVersionStore } from '../../application/ports/perm-version.port';
import { platformAdminWhere } from '../persistence/prisma-admin-mfa.repository';

interface CacheEntry {
  state: AuthState | null;
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
    return (await this.getAuthState(userId))?.permVersion ?? null;
  }

  /**
   * The administrator flag is cached with the version on purpose: every change that can make an
   * account an administrator (a role assignment, a role's grants) bumps `permVersion` and evicts
   * this entry through `PermissionChangeService`, so both are always read together.
   */
  async getAuthState(userId: string): Promise<AuthState | null> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.state;
    }

    const [row, administrators] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { permVersion: true } }),
      this.prisma.user.count({ where: platformAdminWhere(userId) }),
    ]);
    const state = row ? { permVersion: row.permVersion, mfaRequired: administrators > 0 } : null;
    this.cache.set(userId, { state, expiresAt: Date.now() + TTL_MS });
    return state;
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
