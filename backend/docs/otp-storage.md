# OTP storage and verification

Work 60 (storage and verification) and Work 62 (e-mail delivery). This covers where one-time codes are kept, how they are checked, how they reach the user and what to configure.

**Codes are delivered by e-mail only**, when Resend is configured. No SMS gateway is approved, so SMS codes are refused, never reported as sent. See [Delivery](#delivery-work-62) and "Not covered" at the end.

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

**Local staging is not that Redis.** Since Work 61 the local staging stack (`compose.staging.yml`) runs `OTP_STORE=redis` against its own Redis container, with a random local-only `OTP_HASH_SECRET` generated by `--init-env`, and its rehearsal runs an OTP smoke test against it (`ops/staging/README.md`). That container has no authentication, TLS, persistence, replication, backup or recovery. A passing rehearsal shows the adapter works with a real Redis; it is no evidence about any of those production requirements.

| | Local staging stack | Production |
|---|---|---|
| `OTP_STORE` | `redis`, set by `compose.staging.yml` | `redis` (the only value allowed) |
| `OTP_HASH_SECRET` | generated locally into the gitignored `backend/.env.staging` | from the deployment's secret store |
| Redis | the stack's own container: private network, no auth, TLS or persistence | to be provisioned: auth, TLS, persistence and replication |
| `NODE_ENV` | `development` (production startup is blocked on Fayda) | `production` |

## Delivery (Work 62)

Module 01 sends its codes through `IdentityNotificationAdapter` (`src/modules/identity/infrastructure/messaging/`). It sends e-mail through the platform's one e-mail transport, `EMAIL_TRANSPORT` (Resend's REST API). That transport lives in the global shared `EmailModule` (`src/shared/email/`), the same one Module 13's delivery queue uses.

**Why shared:** Module 13 already depends on Module 01, so Module 01 can't import Module 13 without a cycle. The Resend client and configuration moved below both modules instead of being duplicated, and Module 13's old import paths re-export them.

### Channel policy

| Situation | Result |
|---|---|
| Registration with an e-mail address (with or without a phone) | Verified by e-mail; the code goes to the address only |
| Registration with a phone only | `400 VALIDATION_ERROR` (`details.reason: SMS_UNAVAILABLE`) before any account is created |
| Any OTP request for a phone number (resend, forgot-password) | `503 DEPENDENCY_UNAVAILABLE` (`details.channel: SMS`); no code is issued |
| Any e-mail OTP request while Resend is not configured | `503 DEPENDENCY_UNAVAILABLE` (`details.reason: NOT_CONFIGURED`); no code is issued and no account is created |

The policy comes from one method, `INotificationPort.canDeliver(channel)`. The day an SMS gateway is approved, the adapter answers `true` for SMS and phone-only registration works again, with no change to the commands.

Verifying the e-mail activates a pending customer, even one who also gave a phone number; the phone stays unverified. **E-mail verification proves control of an address only.** It never sets `faydaVerifiedAt`, never creates or approves a verification request, and bypasses no identity, licensing or business-verification rule.

### Sending

**Synchronous, while the request waits.** The code goes straight to Resend, with an 8-second limit. It is never written to the outbox, Module 13's notifications or delivery jobs, the audit log or any other table; the only copy at rest is the HMAC in the OTP store. Each message has a fresh idempotency reference, so a new code is never deduplicated against an earlier one.

**Truthful.** A request succeeds only when Resend accepted the message. Anything else is a failure:
- not configured, or credentials refused;
- rejected message or recipient;
- rate limit, outage or timeout;
- an exception, or a reply the adapter doesn't recognise.

There is no fallback to logging.

**Templates:** plain text (`identity-email-templates.ts`):
- registration, sign-in, password reset and step-up codes, each with the code, its lifetime and single use, what to do if the request wasn't yours, and a never-share warning;
- password-changed and password-reset notices.

They contain no name, link, pharmacy, prescription or health information. English only for now.

### When sending fails

| Caller | Response |
|---|---|
| `POST /auth/resend-otp` | `503 DEPENDENCY_UNAVAILABLE`, `details: { channel, reason: FAILED, retryAfterSeconds }` |
| Registration (the `identity.user.registered` handler) | The account stays pending; the failure is logged without the address. The user asks for a new code with resend |
| `POST /auth/password/forgot` | The generic `{ challengeSent: true }`; see below |
| Password-changed / password-reset notices | Best effort: the change stands, and the audit record carries `notice: SENT \| NO_CHANNEL \| FAILED` |

**A code may already exist when a send fails.** The code was issued (and its resend cooldown started) before the send. It stays in the store until it expires, or until a new code replaces it, and nobody has it. So:
- an immediate retry is refused by the cooldown (`429`), which is why the 503 carries `retryAfterSeconds`;
- after the cooldown, resend issues and sends a new code, which replaces the undelivered one;
- the atomic cooldown, attempt limit and single use are unchanged.

When the channel can't deliver at all (SMS, or no Resend), the check happens *before* issuing, so no code exists and no cooldown starts.

**Forgot-password stays non-enumerating.**
- *No provider for the channel:* every identifier gets 503, checked before the account lookup, so the answer is the same for everyone.
- *A send to a known account that Resend didn't accept:* logged without the identifier, and answered with the generic success. Reporting it would reveal that the account exists. With Resend's test sender, which refuses most recipients, that would be on demand.

**Suppression.** Module 13's suppression list (bounces, complaints) belongs to Module 13, so Module 01 doesn't consult it. A user-requested code to a suppressed address is attempted and may bounce.

### Configuration

| Variable | Effect |
|---|---|
| `RESEND_API_KEY` | A Resend API key with sending access (`re_…`). Never logged, never in a response |
| `RESEND_FROM_EMAIL` | A sender on a domain verified in Resend, e.g. `PharmaLink <otp@your-domain>` |

Both must be set, or e-mail is not configured. Under `NODE_ENV=test` it is never configured, so the automated suites cannot send real e-mail. Resend's shared test sender (`onboarding@resend.dev`) delivers only to your own Resend account address; anything else is refused and reported as not delivered.

## Logging

No runtime path logs a code, its hash, the secret, or a raw identifier as part of OTP handling.
- **`InMemoryOtpService`** used to write every code to the log. It doesn't any more.
- **`IdentityNotificationAdapter`** logs a failed send with the template name and the provider's safe result code only (e.g. `template=otp-register result=TRANSIENT/EMAIL_TIMEOUT`). It never logs the address, the code, the message text or a provider response.
- **Tests** read codes from a test-only recording transport (`test/support/recording-notification.adapter.ts`), or from the in-memory e-mail transport's message text.
- **No route** returns a code.

## Not covered by this work

- **SMS delivery.** No SMS gateway is approved: phone-only registration and phone OTPs are refused (see Delivery). Module 13's SMS transport is unconfigured.
- **Real e-mail delivery depends on your Resend account.** It has been exercised only against the in-memory transport in the automated suites, unless a manual smoke test with real credentials is recorded.
- **Fayda / national-ID verification** is still the mock outside production and fails closed in production (ADR-027). E-mail verification is not identity verification.
- **`resend-otp` issues to any well-formed identifier,** registered or not, as before. The per-identifier cooldown and per-IP limits bound it, but an SMS gateway will need its own abuse controls.
- **Production Redis.** The local staging stack uses Redis for OTPs (Work 61), but nothing about a production Redis has been provisioned or verified.
- **No production deployment** has been made or verified.
