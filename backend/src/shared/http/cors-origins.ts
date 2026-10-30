/**
 * Local development origins allowed when `WEB_ORIGIN` is unset: the operations portal (`web/`,
 * Vite on 5173) and the customer app (`app/`, Vite on 5174). Any deployment sets `WEB_ORIGIN`.
 */
export const DEFAULT_WEB_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://localhost:5174'];

/**
 * Parses `WEB_ORIGIN` (comma-separated) into the exact origins CORS allows. A `*` entry is refused:
 * the API takes bearer tokens from browsers, so every allowed origin is named explicitly.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.includes('*')) {
    throw new Error('WEB_ORIGIN must list explicit origins; "*" is not allowed.');
  }
  return origins.length > 0 ? origins : [...DEFAULT_WEB_ORIGINS];
}
