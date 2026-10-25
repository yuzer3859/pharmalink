// Moved to the shared kit so shared infrastructure (the health endpoints) can use it without
// depending on this module. Re-exported here so existing imports keep working unchanged.
export { IS_PUBLIC_KEY, Public } from '../../../../shared/rbac/public.decorator';
