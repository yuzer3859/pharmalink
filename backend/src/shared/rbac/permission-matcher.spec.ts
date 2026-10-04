import {
  hasAllPermissions,
  hasPermission,
  permissionMatches,
} from './permission-matcher';

describe('permissionMatches', () => {
  it('matches exactly', () => {
    expect(permissionMatches('orders:read:own', 'orders:read:own')).toBe(true);
  });

  it('matches a scope wildcard', () => {
    expect(permissionMatches('orders:read:*', 'orders:read:own')).toBe(true);
  });

  it('matches an action wildcard', () => {
    expect(permissionMatches('orders:*', 'orders:read:own')).toBe(true);
  });

  it('treats a shorter grant as a prefix (trailing scope implied)', () => {
    expect(permissionMatches('orders:read', 'orders:read:own')).toBe(true);
  });

  it('super-admin "*" matches anything', () => {
    expect(permissionMatches('*', 'anything:at:all')).toBe(true);
  });

  it('does not match a different resource', () => {
    expect(permissionMatches('orders:read:own', 'payments:read:own')).toBe(false);
  });

  it('does not match a different scope', () => {
    expect(permissionMatches('orders:read:own', 'orders:read:any')).toBe(false);
  });

  it('does not let a longer grant match a shorter requirement', () => {
    expect(permissionMatches('orders:read:own', 'orders:read')).toBe(false);
  });
});

describe('hasPermission / hasAllPermissions', () => {
  const granted = ['orders:read:*', 'profiles:read:own'];

  it('hasPermission finds a satisfying grant', () => {
    expect(hasPermission(granted, 'orders:read:own')).toBe(true);
    expect(hasPermission(granted, 'orders:write:own')).toBe(false);
  });

  it('hasAllPermissions requires every permission', () => {
    expect(hasAllPermissions(granted, ['orders:read:own', 'profiles:read:own'])).toBe(true);
    expect(hasAllPermissions(granted, ['orders:read:own', 'payments:read:own'])).toBe(false);
  });
});
