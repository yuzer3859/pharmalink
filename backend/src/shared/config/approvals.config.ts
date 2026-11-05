import { registerAs } from '@nestjs/config';

/**
 * The `approvals` configuration namespace: maker-checker (Work 82, NFR-SEC-06,
 * backend/docs/maker-checker.md).
 *
 * Two governed keys, both read through `IConfigPort` by `MakerCheckerGate` and therefore also
 * publishable through `PUT /admin/config/approvals/...` (see `ConfigCatalogue`):
 *
 * - `approvals.makerCheckerActions` — the action types that need a second administrator.
 * - `approvals.ttlHours` — how long a pending request waits for a checker before it expires.
 */

/**
 * Every action type an owning module has registered with the maker-checker registry, and so the
 * only values `approvals.makerCheckerActions` may hold.
 *
 * Empty in Work 82, which builds the workflow but puts no existing action behind it; Works 83
 * (settlements) and 84 (high-value refunds) append the types they register. A value nobody
 * executes would be configuration that does nothing, so it is refused rather than stored.
 */
export const MAKER_CHECKER_ACTION_TYPES: readonly string[] = [];

export const APPROVALS_MAKER_CHECKER_ACTIONS_ENV = 'APPROVALS_MAKER_CHECKER_ACTIONS';
export const APPROVALS_TTL_HOURS_ENV = 'APPROVALS_TTL_HOURS';

/** Seventy-two hours: long enough to cover a weekend, short enough that a stale request lapses. */
export const DEFAULT_APPROVALS_TTL_HOURS = 72;
export const MIN_APPROVALS_TTL_HOURS = 1;
/** Thirty days. A request older than that describes a situation that has likely changed. */
export const MAX_APPROVALS_TTL_HOURS = 720;

/**
 * Parses `APPROVALS_MAKER_CHECKER_ACTIONS` (comma-separated). Unset or blank is the empty list:
 * no action needs a checker, which is how the platform behaved before Work 82.
 *
 * Throws on a type that is not registered, so a typo fails at boot instead of leaving the action
 * it meant to protect single-actor.
 */
export function readMakerCheckerActions(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
  known: readonly string[] = MAKER_CHECKER_ACTION_TYPES,
): string[] {
  const raw = env[APPROVALS_MAKER_CHECKER_ACTIONS_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return [];
  }
  const actions = [
    ...new Set(
      String(raw)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ];
  const unknown = actions.filter((action) => !known.includes(action));
  if (unknown.length > 0) {
    throw new Error(
      `${APPROVALS_MAKER_CHECKER_ACTIONS_ENV} names unregistered action types: ${unknown.join(', ')}`,
    );
  }
  return actions;
}

/** Parses `APPROVALS_TTL_HOURS`, falling back to the default when unset or blank. */
export function readApprovalsTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[APPROVALS_TTL_HOURS_ENV];
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_APPROVALS_TTL_HOURS;
  }
  return Number(raw);
}

export const approvalsConfig = registerAs('approvals', () => ({
  makerCheckerActions: readMakerCheckerActions(),
  ttlHours: readApprovalsTtlHours(),
}));
