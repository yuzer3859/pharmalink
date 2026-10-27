import { isIP } from 'net';

/**
 * HTTP security settings (Work 59): trusted proxies, rate limits and HSTS.
 * See `backend/docs/http-security.md`.
 */

// ── Trusted proxies ──────────────────────────────────────────────────────────────────────────

/**
 * Express's named address ranges. `loopback` is 127.0.0.0/8 and ::1; `linklocal` and `uniquelocal`
 * are the private ranges a sidecar or in-cluster proxy typically uses.
 */
const TRUST_PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * Parses `TRUST_PROXY` into the value handed to Express's `trust proxy` setting, or throws.
 *
 * - unset, empty or `false` → `false`: forwarded headers are ignored and the client is the TCP peer.
 *   This is the default and the only safe setting without a reverse proxy.
 * - otherwise a comma-separated list of proxy addresses: IPv4/IPv6 addresses, CIDR subnets, or the
 *   keywords `loopback`, `linklocal`, `uniquelocal`. Express then walks `X-Forwarded-For` from the
 *   right and stops at the first address that is not a listed proxy, so a client cannot choose its
 *   own identity by prepending entries.
 *
 * Deliberately rejected: `true`/`*` (trust every hop, so any client could spoof its address) and
 * hop counts such as `1` (correct only while the topology never changes, and silently wrong
 * after). Name the proxies instead.
 */
export function parseTrustProxy(raw: unknown): false | string[] {
  const value = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw);
  if (value === '' || value.toLowerCase() === 'false') return false;

  const entries = value.split(',').map((e) => e.trim());
  if (entries.some((e) => e === '')) {
    throw new Error('TRUST_PROXY contains an empty entry.');
  }
  for (const entry of entries) {
    if (TRUST_PROXY_KEYWORDS.has(entry)) continue;
    if (/^(true|\*|all)$/i.test(entry)) {
      throw new Error(`TRUST_PROXY must not trust every proxy ("${entry}"); list the proxy addresses or subnets.`);
    }
    if (/^\d+$/.test(entry)) {
      throw new Error(`TRUST_PROXY hop counts ("${entry}") are not supported; list the proxy addresses or subnets.`);
    }
    if (!isAddressOrSubnet(entry)) {
      throw new Error(
        `TRUST_PROXY entry "${entry}" is not an IP address, a CIDR subnet or one of loopback, linklocal, uniquelocal.`,
      );
    }
  }
  return entries;
}

function isAddressOrSubnet(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

// ── Rate limits ──────────────────────────────────────────────────────────────────────────────

/** Requests per window per client per route, for the sensitive authentication endpoints. */
export const DEFAULT_RATE_LIMIT_AUTH_LIMIT = 10;
export const DEFAULT_RATE_LIMIT_AUTH_TTL_SECONDS = 60;
/** Requests per window per client per route, for every other route except the health probes. */
export const DEFAULT_RATE_LIMIT_DEFAULT_LIMIT = 300;
export const DEFAULT_RATE_LIMIT_DEFAULT_TTL_SECONDS = 60;

/** Bounds enforced at boot. There is no "0 = unlimited": a limit is always in force. */
export const MIN_RATE_LIMIT = 1;
export const MAX_RATE_LIMIT = 100_000;
export const MIN_RATE_LIMIT_TTL_SECONDS = 1;
export const MAX_RATE_LIMIT_TTL_SECONDS = 86_400;

// ── HSTS ─────────────────────────────────────────────────────────────────────────────────────

/** `0` (the default) sends no `Strict-Transport-Security` header. */
export const DEFAULT_HTTP_HSTS_MAX_AGE_SECONDS = 0;
/** Two years: the usual ceiling, and the preload-list minimum is one year. */
export const MAX_HTTP_HSTS_MAX_AGE_SECONDS = 63_072_000;
