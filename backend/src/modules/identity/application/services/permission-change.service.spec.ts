import { IRbacRepository } from '../../domain/repositories/rbac.repository';
import { IPermVersionStore } from '../ports/perm-version.port';
import { IPermissionCacheInvalidator } from '../ports/permission-cache.port';
import { PermissionChangeService } from './permission-change.service';

describe('PermissionChangeService', () => {
  it('de-duplicates users, bumps permVersion and evicts both caches', async () => {
    const rbac = { bumpPermVersion: jest.fn().mockResolvedValue(undefined) } as unknown as IRbacRepository;
    const cache = { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as IPermissionCacheInvalidator;
    const permVersions = { getCurrent: jest.fn(), invalidate: jest.fn() } as unknown as IPermVersionStore;

    await new PermissionChangeService(rbac, cache, permVersions).propagate(['user-1', 'user-1', 'user-2']);

    expect(rbac.bumpPermVersion).toHaveBeenCalledWith(['user-1', 'user-2']);
    expect(cache.invalidate).toHaveBeenCalledWith(['user-1', 'user-2']);
    expect(permVersions.invalidate).toHaveBeenCalledWith(['user-1', 'user-2']);
  });

  it('bumps the stored version before evicting, so no reader can cache the old value', async () => {
    const order: string[] = [];
    const rbac = {
      bumpPermVersion: jest.fn().mockImplementation(async () => {
        order.push('bump');
      }),
    } as unknown as IRbacRepository;
    const cache = {
      invalidate: jest.fn().mockImplementation(async () => {
        order.push('evict-permissions');
      }),
    } as unknown as IPermissionCacheInvalidator;
    const permVersions = {
      getCurrent: jest.fn(),
      invalidate: jest.fn().mockImplementation(() => {
        order.push('evict-version');
      }),
    } as unknown as IPermVersionStore;

    await new PermissionChangeService(rbac, cache, permVersions).propagate(['user-1']);

    expect(order).toEqual(['bump', 'evict-permissions', 'evict-version']);
  });

  it('is a no-op when nobody is affected', async () => {
    const rbac = { bumpPermVersion: jest.fn() } as unknown as IRbacRepository;
    const cache = { invalidate: jest.fn() } as unknown as IPermissionCacheInvalidator;
    const permVersions = { getCurrent: jest.fn(), invalidate: jest.fn() } as unknown as IPermVersionStore;

    await new PermissionChangeService(rbac, cache, permVersions).propagate([]);

    expect(rbac.bumpPermVersion).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(permVersions.invalidate).not.toHaveBeenCalled();
  });
});
