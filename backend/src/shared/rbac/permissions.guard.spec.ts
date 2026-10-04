import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '../errors/api-exception';
import { ErrorCode } from '../errors/error-codes';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionsGuard } from './permissions.guard';
import { AuthenticatedPrincipal, IPermissionResolver } from './rbac.types';

function contextWith(
  required: string[] | undefined,
  user?: AuthenticatedPrincipal,
): { context: ExecutionContext; reflector: Reflector } {
  const reflector = {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('PermissionsGuard', () => {
  it('allows routes without @RequirePermissions', async () => {
    const { context, reflector } = contextWith(undefined);
    const guard = new PermissionsGuard(reflector, new PermissionCacheService());
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('throws UNAUTHENTICATED when no principal is present', async () => {
    const { context, reflector } = contextWith(['orders:read:own']);
    const guard = new PermissionsGuard(reflector, new PermissionCacheService());
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: ErrorCode.UNAUTHENTICATED,
    });
  });

  it('allows when the principal carries sufficient embedded permissions', async () => {
    const { context, reflector } = contextWith(['orders:read:own'], {
      userId: 'u1',
      permissions: ['orders:read:*'],
    });
    const guard = new PermissionsGuard(reflector, new PermissionCacheService());
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('throws FORBIDDEN when permissions are insufficient', async () => {
    const { context, reflector } = contextWith(['orders:write:own'], {
      userId: 'u1',
      permissions: ['orders:read:own'],
    });
    const guard = new PermissionsGuard(reflector, new PermissionCacheService());
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ApiException);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('falls back to the resolver and caches the result', async () => {
    const resolver: IPermissionResolver = {
      resolvePermissions: jest.fn().mockResolvedValue(['orders:read:own']),
    };
    const cache = new PermissionCacheService();
    const { context, reflector } = contextWith(['orders:read:own'], { userId: 'u1' });
    const guard = new PermissionsGuard(reflector, cache, resolver);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolver.resolvePermissions).toHaveBeenCalledTimes(1);
    expect(cache.get('u1')).toEqual(['orders:read:own']);

    // second call served from cache — resolver not called again
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolver.resolvePermissions).toHaveBeenCalledTimes(1);
  });
});
