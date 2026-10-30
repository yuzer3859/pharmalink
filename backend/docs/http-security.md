# HTTP security: headers, rate limits, trusted proxies

Work 59. This covers what the backend enforces at the HTTP layer and how to configure it. It does not make PharmaLink production-ready; see "Not covered" at the end.

## Security headers

Applied to every HTTP response, including errors, by `src/shared/http/http-security.ts` (Helmet). It's called from `main.ts` and from the e2e harness, so tests exercise the same stack that ships.

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'` | The API serves JSON only, so nothing may load. CSP applies to documents, not to fetch/XHR, so API clients are unaffected. |
| `X-Frame-Options` | `DENY` | Responses must never be framed. |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `no-referrer` | |
| `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` | `same-origin` | CORS (`WEB_ORIGIN`) still governs cross-origin `fetch`. |
| `Strict-Transport-Security` | **off by default**; `max-age=<HTTP_HSTS_MAX_AGE_SECONDS>` when set, without `includeSubDomains` | Local HTTP must not claim HTTPS, and other subdomains aren't ours to pin. |
| `X-Powered-By` | removed | |

Helmet's other defaults also apply, among them `X-DNS-Prefetch-Control: off`, `X-Permitted-Cross-Domain-Policies: none` and `X-XSS-Protection: 0`.

**Error responses** were already safe and are unchanged. `AllExceptionsFilter` returns the standard envelope; unexpected errors become a generic 500, with the stack written to the server log only.

## Rate limits

The global guard (`HttpSecurityModule`, `RateLimitGuard`) is built on `@nestjs/throttler`. Every limit is **per client, per route**, so exhausting one route doesn't lock the client out of others.

| Policy | Applies to | Default | Settings |
|---|---|---|---|
| `auth` (strict) | `POST /auth/register`, `/auth/verify-otp`, `/auth/resend-otp`, `/auth/login`, `/auth/token/refresh`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/password/change`, `/verification/fayda` | 10 per 60 s | `RATE_LIMIT_AUTH_LIMIT`, `RATE_LIMIT_AUTH_TTL_SECONDS` |
| `default` | every other HTTP route, and the routes above as well | 300 per 60 s | `RATE_LIMIT_DEFAULT_LIMIT`, `RATE_LIMIT_DEFAULT_TTL_SECONDS` |
| none | `GET /health/live`, `/health/ready` | exempt (`@SkipThrottle`) | |

**Applying the limits**
- **New routes:** mark any new credential, OTP, recovery or identity endpoint with `@SensitiveRateLimit()` (`src/shared/http/rate-limit.decorator.ts`).
- **When a limit is exceeded:** HTTP `429`, the standard envelope with `error.code = RATE_LIMITED`, and `Retry-After` in seconds. The client stays blocked until the window it opened expires. Request bodies, OTPs, passwords and tokens are never logged or echoed.
- **Validation:** limits are checked at boot as integers, 1–100,000 requests and 1–86,400 seconds. There is no value that turns limiting off; `0`, negative or non-numeric values stop startup.
- **Existing per-account protections stay:** the OTP's maximum attempts per code, and its resend cooldown (enforced across instances since Work 60; see [otp-storage.md](otp-storage.md)).

**Client identity** is `req.ip`. Without trusted proxies (the default) that's the TCP peer, and `X-Forwarded-For` is ignored, so a client can't pick a new identity by sending the header. Behind configured proxies, see below. IPv6 clients are grouped by /64 (the library's default subnet), so one host cannot evade a limit by rotating addresses within its own /64.

**Shared state**
- **`REDIS_URL` set:** counters are kept in Redis with one atomic Lua script, so all backend instances share them. Keys are hashes namespaced by `REDIS_KEY_PREFIX`, never raw IPs.
- **`REDIS_URL` unset:** counters live in each process's memory. That is correct for **one instance only**; with N instances a client gets up to N times the limit. The startup log says which mode is active.
- **Redis configured but failing:** requests are counted in memory per instance, with a warning at most once a minute. Limits never switch off.

## Trusted proxies

`TRUST_PROXY` is validated at boot and becomes Express's `trust proxy` setting.

- **Unset or `false` (default):** no proxy is trusted. `req.ip` is the TCP peer, `X-Forwarded-For` and `X-Forwarded-Proto` are ignored, and `req.protocol` reflects the actual connection. This is correct for local development and for any setup without a reverse proxy.
- **A comma-separated list of the reverse proxies' addresses:** IPs, CIDR subnets, or `loopback`, `linklocal`, `uniquelocal`. Express walks `X-Forwarded-For` from the right and stops at the first address that isn't a listed proxy. A client that prepends fake addresses therefore still ends up identified by the address its connection actually came from.
- **Rejected at boot:**
  - `true`, `*` or `all`, which would let any client spoof its address;
  - hop counts such as `1`, which are correct only until the topology changes;
  - hostnames and malformed addresses.

**For an authorised staging operator behind a known reverse proxy:**
1. Find the address or subnet the backend sees for the proxy (for example from `req.ip` in the access log while `TRUST_PROXY` is unset).
2. Set `TRUST_PROXY` to exactly that address or subnet, for example `10.0.3.7` or `10.0.3.0/24`. Don't use a range wider than the proxies themselves.
3. Make sure the proxy **overwrites** `X-Forwarded-For` with the client's address (or appends it), and that the backend is reachable **only** through the proxy. If clients can reach the backend directly, from inside the trusted range, they can forge the header.
4. If the proxy terminates HTTPS, set `HTTP_HSTS_MAX_AGE_SECONDS` (start small, for example `300`, then raise it) only once every client reaches the API over HTTPS.
5. Confirm with a request through the proxy: rate limiting should distinguish two different client addresses, and adding a fake `X-Forwarded-For` should not change a client's identity.

No real proxy addresses are configured in this repository.

## CORS (Work 63)

`main.ts` allows exactly the origins in `WEB_ORIGIN` (comma-separated), parsed by `src/shared/http/cors-origins.ts`. Unset, it allows the two local development front ends: the operations portal (`web/`, `http://localhost:5173`) and the customer app (`app/`, `http://localhost:5174`). A `*` entry stops the backend at startup: browsers send bearer tokens to this API, so every origin is named. Any deployed front end must be listed in `WEB_ORIGIN`.

## Not covered by this work

- **Production use** still requires real SMS, payments and Fayda integrations, persistent proof-of-delivery storage, and Redis configured for rate limits wherever more than one instance runs. Proof-of-delivery storage already forces a single instance. OTPs are stored in Redis in production since Work 60 ([otp-storage.md](otp-storage.md)), but are still not delivered.
- **Webhooks:** `POST /webhooks/payments/*` and `/webhooks/resend` are under the `default` limit per source address. A provider that bursts above it receives 429 and is expected to retry. Revisit the limit when a real provider's delivery pattern is known.
- **The WebSocket tracking gateway** is excluded from the HTTP guard. It's authenticated and has its own cadence rules.
- **To verify on a real staging environment:**
  - headers through the actual proxy;
  - `TRUST_PROXY` against the real topology;
  - HSTS once HTTPS is in place;
  - shared counters with Redis across instances.
