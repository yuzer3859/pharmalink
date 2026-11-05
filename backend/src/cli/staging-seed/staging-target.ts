/**
 * Where the staging seed and the staging password command may run (Work 80): only against the
 * local staging stack's database, never in production and never under the test suites.
 *
 * Two independent checks, both required:
 * - the configured `DATABASE_URL` names the staging database, and
 * - the database the connection actually reached (`SELECT current_database()`) is that database.
 * The second catches a URL that was rewritten by a proxy, a search path or a typo that still
 * happens to contain the name.
 */
export const STAGING_DATABASE_NAME = 'pharmalink_staging';

export interface StagingTargetInput {
  nodeEnv: string | undefined;
  databaseUrl: string | undefined;
  /** `SELECT current_database()` over the live connection; `null` before it has been asked. */
  currentDatabase: string | null;
}

/** Returns the refusal reason, or `null` when the target is the staging database. */
export function stagingTargetRefusal(input: StagingTargetInput): string | null {
  const nodeEnv = (input.nodeEnv ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') return 'NODE_ENV is production. The staging seed never runs in production.';
  if (nodeEnv === 'test') return 'NODE_ENV is test. The staging seed is not part of the test suites.';

  const urlDatabase = databaseNameOf(input.databaseUrl);
  if (urlDatabase === null) return 'DATABASE_URL is not set or is not a PostgreSQL URL.';
  if (urlDatabase !== STAGING_DATABASE_NAME) {
    return `DATABASE_URL names the database "${urlDatabase}", not "${STAGING_DATABASE_NAME}".`;
  }
  if (input.currentDatabase !== null && input.currentDatabase !== STAGING_DATABASE_NAME) {
    return `The connection reached the database "${input.currentDatabase}", not "${STAGING_DATABASE_NAME}".`;
  }
  return null;
}

/** The database name in a PostgreSQL URL, or `null`. Never returns credentials or the host. */
export function databaseNameOf(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null;
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  return name.length > 0 ? name : null;
}
