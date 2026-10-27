# OTP storage and verification

Work 60. This covers where one-time codes are kept, how they are checked and what to configure. **It is about storage and verification only. It does not deliver codes:** no SMS gateway is approved or configured, so users cannot receive production OTPs yet. See "Not covered" at the end.

## Stores

`OTP_STORE` chooses the adapter behind `IOtpService` at startup (`src/modules/identity/infrastructure/otp/otp.providers.ts`). Nothing switches stores later.

| `OTP_STORE` | Adapter | Where it may run |
|---|---|---|
| `redis` | `RedisOtpService`: shared Redis, survives a backend restart, shared by every instance | Everywhere. **The only production value**, and the production default when unset |
| `memory` | `InMemoryOtpService`: one process, lost on restart | Local development and tests only. The default outside production. **Rejected in production**, at boot and again by the adapter's own constructor |

- **`redis` requires `REDIS_URL` and `OTP_HASH_SECRET`.** Production therefore refuses to start without both. Outside production the same rule applies whenever `OTP_STORE=redis`.
- **No fallback, in either direction.** If Redis is configured but unreachable, slow or failing, OTP requests fail closed (below). They never move to memory.

## How a challenge works

One challenge exists per **normalized identifier** (E.164 phone, lower-cased email) and **purpose** (`REGISTER`, `LOGIN`, `RESET`, `STEP_UP`).

- **Code:** six digits from Node's CSPRNG (`crypto.randomInt`).
- **Stored value:** `HMAC-SHA256(OTP_HASH_SECRET, purpose, identifier tag, code)` and an attempt counter. Never the code.
  - A plain hash of a six-digit code could be reversed by trying all 10⁶ codes. The HMAC can't be, without the secret, and Redis never holds the secret.
  - Binding the purpose and identifier into the hash means a stored value is useless for any other challenge.
- **Keys:** `<REDIS_KEY_PREFIX>:otp:v1:{<purpose>:<identifier tag>}` and `…:cooldown`.
  - The identifier tag is an HMAC of the normalized phone or email, so no raw phone number or email appears in Redis.
  - The prefix keeps environments that share a Redis apart.
  - The `{…}` hash tag keeps both keys in one slot, should Redis ever be clustered.
- **Lifetime:** `OTP_TTL_SECONDS` (default 300). Redis deletes the challenge itself when it expires.
- **Attempts:** each wrong code counts one attempt.
  - With `OTP_MAX_ATTEMPTS` = 5 (the default), five wrong codes are answered `AUTH_OTP_INVALID`.
  - The next verification, even with the right code, is answered `AUTH_OTP_ATTEMPTS_EXCEEDED` and deletes the challenge. The user then needs a new code.
- **Single use:** the right code deletes the challenge, so a replay is answered `AUTH_OTP_EXPIRED`.
- **Replacement:** issuing a code deletes the previous challenge, including its attempt count, for the same identifier and purpose.
- **Isolation:** a `REGISTER` code cannot verify `LOGIN`, `RESET` or `STEP_UP`, or another identifier.

**Atomicity.** Issue and verify are each one Lua script, so Redis runs them one at a time. Concurrent requests from any number of instances therefore can't:
- verify one challenge twice;
- get more than `OTP_MAX_ATTEMPTS` wrong guesses;
- both pass the resend cooldown.

The e2e suite runs exactly those races against a real Redis.

## Resend cooldown

After a code is issued, no new code is issued for the same identifier and purpose for `OTP_RESEND_COOLDOWN_SECONDS` (default 30). The cooldown key is set in the same script as the challenge, so it holds across instances and backend restarts.

| Caller | During the cooldown |
|---|---|
| `POST /auth/resend-otp` | `429 RATE_LIMITED` with `error.details.retryAfterSeconds`. Nothing is issued or sent. |
| `POST /auth/password/forgot` | The usual `{ challengeSent: true }`, but nothing is issued or sent. A different answer would reveal that the account exists. |
| Registration event handler | Keeps the code already issued, for example when the client called resend before the event was relayed, and issues no second one. |

- **Behaviour change:** before Work 60 the in-memory store only *reported* the cooldown and issued a new code anyway.
- **Response field:** `cooldownSeconds` in the resend response is now the time until the next resend is allowed.
- **IP rate limits still apply:** the per-IP rate limits in [http-security.md](http-security.md) apply on top of this per-identifier cooldown.

## When Redis is unavailable

**Bounded.** The shared connection fails commands fast: there is no offline queue and at most one retry. Each OTP script also has a 2-second limit.

**Fail closed.** If Redis is off, unreachable, errors or doesn't answer in time:
- issue and verify fail with `503 DEPENDENCY_UNAVAILABLE`;
- nothing is sent;
- nothing is verified;
- no outcome is guessed: an unknown state is never reported as expired, invalid or OK.

The exception is `POST /auth/password/forgot`, which still returns its generic success to stay non-enumerating; no code is issued.

**What is logged.** One warning naming the operation and purpose, never the identifier, code or hash. The exception filter also logs its usual 5xx entry.

**After a timeout.** A script that times out may still complete in Redis afterwards. Either way the state is safe:
- an issued code that was never sent only starts a cooldown;
- a code consumed after its request already failed means the user requests a new one.

## Configuration

| Variable | Default | Rule |
|---|---|---|
| `OTP_STORE` | `redis` in production, `memory` elsewhere | `redis` or `memory`; `memory` rejected in production |
| `OTP_HASH_SECRET` | none | Required for `redis`. At least 32 characters, random. Placeholders, low-entropy values and a copy of `JWT_*_SECRET` or `MASTER_ENCRYPTION_KEY` are rejected. The value is never echoed in errors |
| `OTP_TTL_SECONDS` | 300 | 30–3600 |
| `OTP_MAX_ATTEMPTS` | 5 | 1–20 |
| `OTP_RESEND_COOLDOWN_SECONDS` | 30 | 1–3600 |
| `REDIS_URL`, `REDIS_KEY_PREFIX` | | The shared connection. `REDIS_URL` is required for `redis` |

**Generating the secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Handling the secret:**
- Keep it in the deployment's secret store, never in Redis or the repository.
- Rotating it invalidates every outstanding code, and orphans their keys until their TTLs expire. Users simply request a new code.

## Operating Redis for OTPs

Redis is the system of record for live challenges. A Redis restart loses them, unless that Redis is configured to persist (AOF or RDB) or is replicated with failover. Losing them is a nuisance, not a security failure: users request a new code. But the production Redis needs:
- authentication and TLS where the network isn't private;
- no public exposure;
- the persistence and availability the architecture calls for (module-01 §4 and §16: OTP state in Redis, with replicas).

**Staging is not that Redis.** The local staging stack's Redis container is a rehearsal dependency with none of this configured, and it isn't evidence that production persistence is set up.

## Logging

No runtime path logs a code, its hash, the secret, or a raw identifier as part of OTP handling.
- **`InMemoryOtpService`** used to write every code to the log. It doesn't any more.
- **The Identity module's notification adapter** (`LogNotificationAdapter`) logs only the channel, a masked recipient and the template name.
- **Tests** read codes from a test-only recording transport (`test/support/recording-notification.adapter.ts`).
- **No route** returns a code.

## Not covered by this work

- **SMS delivery.** No SMS gateway is approved. The Identity module's notification port is still the log-only adapter, and Module 13's SMS transport is unconfigured. Codes are stored and verifiable but reach no user outside the test suite, and local development can no longer read them from the logs.
- **Fayda / national-ID verification** is still the mock outside production and fails closed in production (ADR-027).
- **`resend-otp` issues to any well-formed identifier,** registered or not, as before. The per-identifier cooldown and per-IP limits bound it, but an SMS gateway will need its own abuse controls.
- **The local staging stack** still runs `OTP_STORE=memory` (unset, `NODE_ENV=development`). Switching it to Redis means adding `OTP_STORE=redis` and an `OTP_HASH_SECRET` to its env file.
- **No production deployment** has been made or verified.
