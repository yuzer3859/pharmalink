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
 * only values `approvals.makerCheckerActions` may hold. A value nobody executes would be
 * configuration that does nothing, so it is refused rather than stored.
 *
 * Work 83: settlement approval, payout and payout-destination verification (Module 07).
 */
export const MAKER_CHECKER_ACTION_TYPES: readonly string[] = [
  'SETTLEMENT_APPROVE',
  'SETTLEMENT_PAYOUT',
  'PAYOUT_BENEFICIARY_VERIFY',
];

/**
 * What needs a checker when `APPROVALS_MAKER_CHECKER_ACTIONS` is unset: every money action. Secure
 * by default — switching one off is a deliberate, audited configuration publish (`[]` turns all
 * off), never the absence of a setting.
 */
export const DEFAULT_MAKER_CHECKER_ACTIONS: readonly string[] = MAKER_CHECKER_ACTION_TYPES;

export const APPROVALS_MAKER_CHECKER_ACTIONS_ENV = 'APPROVALS_MAKER_CHECKER_ACTIONS';
export const APPROVALS_TTL_HOURS_ENV = 'APPROVALS_TTL_HOURS';

/** Seventy-two hours: long enough to cover a weekend, short enough that a stale request lapses. */
export const DEFAULT_APPROVALS_TTL_HOURS = 72;
export const MIN_APPROVALS_TTL_HOURS = 1;
/** Thirty days. A request older than that describes a situation that has likely changed. */
export const MAX_APPROVALS_TTL_HOURS = 720;

/**
 * Parses `APPROVALS_MAKER_CHECKER_ACTIONS` (comma-separated). Unset or blank is
 * `DEFAULT_MAKER_CHECKER_ACTIONS`; `none` is the explicit empty list.
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
    return [...DEFAULT_MAKER_CHECKER_ACTIONS].filter((action) => known.includes(action));
  }
  if (String(raw).trim().toLowerCase() === 'none') {
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
