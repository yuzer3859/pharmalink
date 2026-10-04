/**
 * Permission model: `resource:action[:scope]` (see architecture/00-shared-conventions.md §6).
 * Wildcards: a granted `*` segment matches any value in that position, and a shorter grant acts
 * as a prefix (trailing segments treated as wildcards). Examples:
 *   grant "orders:read:*"  matches required "orders:read:own"
 *   grant "orders:*"       matches required "orders:read:own"
 *   grant "*"              matches anything (super-admin)
 *   grant "orders:read"    matches required "orders:read:own" (trailing scope implied)
 */
export function permissionMatches(granted: string, required: string): boolean {
  const g = granted.split(':');
  const r = required.split(':');
  if (g.length > r.length) {
    return false;
  }
  return g.every((seg, i) => seg === '*' || seg === r[i]);
}

/** True if ANY granted permission satisfies the single required permission. */
export function hasPermission(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) {
    if (permissionMatches(g, required)) {
      return true;
    }
  }
  return false;
}

/** True only if EVERY required permission is satisfied by the granted set. */
export function hasAllPermissions(
  granted: Iterable<string>,
  required: readonly string[],
): boolean {
  const grantedArr = Array.from(granted);
  return required.every((req) => hasPermission(grantedArr, req));
}
