# Administrator MFA (Work 66)

Platform administrators sign in with a password **and** an authenticator app (TOTP, RFC 6238). They
never receive an access token or refresh token from the password alone, from an e-mail or SMS code,
or from a refresh token that was issued without MFA.

MFA has no on/off switch, in any environment. This page describes what is enforced, how to set it
up and how recovery works. It does not make the platform production-ready on its own; see
"Production prerequisites".

## Who must use it

An account is a **platform administrator** when either:

1. its `primaryRole` is `ADMIN` or `SUPER_ADMIN`; or
2. it holds a **global** assignment (no organisation) of the `ADMIN` or `SUPER_ADMIN` role, and that
   role is PLATFORM-scoped.

An organisation-scoped assignment never counts. The server decides from stored data on every sign-in,
refresh and request. The portal a user picks in the web console has no influence, and nothing a client
sends can change the decision. If the check can't be completed (for example, the database is
unreachable), the request fails: nothing is issued.

Everyone else (customers, pharmacy staff, drivers, finance officers…) signs in as before.

## Sign-in flows

### Password step

`POST /auth/login` with the identifier, password and `deviceInfo`. For an administrator, a correct
password returns a **challenge** instead of tokens:

```json
{ "mfaRequired": true, "challenge": { "type": "TOTP", "token": "<43 characters>", "expiresAt": "…" } }
```

- `type: "ENROLLMENT"`: no authenticator is enrolled yet (first sign-in).
- `type: "TOTP"`: enter the authenticator code.

Login history records `MFA_REQUIRED`; no device, session or refresh token is created.

### First sign-in: enrolment

1. `POST /auth/mfa/enrollment/start` `{ challengeToken }` returns the setup key (`secret`, base32), an
   `otpauth://` URI, the issuer (`PharmaLink`), the account name, and the parameters (SHA1, 6 digits,
   30 seconds). The secret is returned **only in this response**. Calling it again on the same
   challenge generates a new secret (for example if the first one was lost) but never extends the
   challenge.
2. Add the account to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
   …) by typing the setup key, or by giving the app the `otpauth://` URI.
3. `POST /auth/mfa/enrollment/confirm` `{ challengeToken, code, deviceInfo }` with the code the app
   shows. A valid code enables MFA, returns a normal session **and ten recovery codes**, shown once.

### Later sign-ins

`POST /auth/mfa/verify` `{ challengeToken, code, deviceInfo }` with the current authenticator code
returns a normal session.

### The web operations portal

The portal follows the server: after the password it shows the authenticator step, the enrolment
step (setup key and `otpauth://` text, entered manually) or the recovery step, and after enrolment it
shows the recovery codes once and requires "I have saved my recovery codes" before continuing.
Challenge tokens, the setup key and recovery codes are kept in component memory only: never in
local storage, session storage, the URL or logs. No QR code is drawn: the portal has no local QR
library, and a secret must never be sent to an external QR-generation service.

## TOTP parameters

| Parameter | Value |
|---|---|
| Algorithm | HMAC-SHA1 (the authenticator-app default) |
| Digits | 6 |
| Period | 30 seconds |
| Secret | 160 random bits, base32 |
| Clock skew | the current step and one step either side (±30 seconds) |
| Replay | the highest accepted step is stored; a code is accepted only if its step is newer |

The implementation (`src/modules/identity/domain/mfa/totp.ts`) uses Node's HMAC and is checked against
the RFC 6238 Appendix B test vectors. Replay protection is a conditional database update, so the same
code can't be accepted twice, even by two concurrent requests or on two different challenges.

## Challenges

- 256-bit random token, returned once; only its SHA-256 hash is stored.
- Bound to one user and one purpose (`ENROLL` or `VERIFY`). An enrolment challenge can't be used to
  sign in, and a sign-in challenge can't be used to enrol.
- Expires after **5 minutes**. Dead after **5 failed codes**.
- Consumed atomically on success (conditional update); a consumed, expired or exhausted challenge is
  rejected with the same `AUTH_MFA_CHALLENGE_INVALID`, so the response reveals nothing more.
- Not an access token: it authorizes only the `/auth/mfa/*` challenge endpoints. The account is always
  taken from the challenge; no endpoint accepts a user id.
- All MFA endpoints use the sensitive-endpoint rate limit (`RATE_LIMIT_AUTH_*`, see
  [http-security.md](http-security.md)).

| Error | When |
|---|---|
| `AUTH_MFA_CHALLENGE_INVALID` (401) | Unknown, expired, consumed, wrong-purpose or exhausted challenge. Sign in again |
| `AUTH_MFA_CODE_INVALID` (401) | Wrong, out-of-window or already-used code. Counts as a failed attempt |
| `AUTH_MFA_REQUIRED` (401) | An administrator session without MFA assurance (see below). Sign in again |
| `DEPENDENCY_UNAVAILABLE` (503) | `ADMIN_MFA_ENCRYPTION_KEY` isn't configured (outside production) |

## Every session path enforces it

| Path | Behaviour for an administrator |
|---|---|
| `POST /auth/login` | Challenge, never tokens |
| `POST /auth/verify-otp` (REGISTER or LOGIN, with `deviceInfo`) | The code still verifies the phone or e-mail (and activates a pending account), but returns `{ verified: true, mfaRequired: true }` and no session. E-mail or SMS codes are never an administrator's second factor |
| `POST /auth/token/refresh` | Refused with `AUTH_MFA_REQUIRED`, and the token family revoked, unless the family was issued after MFA |
| Every authenticated request (`JwtAuthGuard`) and WebSocket connection | Refused with `AUTH_MFA_REQUIRED` unless the access token carries MFA assurance |
| `AuthSessionIssuerService.issue` | Refuses any administrator without MFA, whoever calls it: the backstop for any future session issuer |

MFA assurance is recorded as `mfaVerifiedAt` on the session and on the refresh token, copied to every
rotated refresh token, and carried in the access token as `mfa: true`. The administrator check is made
against current roles, so assurance can't be inherited from a time before the account became an
administrator.

## Existing sessions and promotions

- **Rollout.** The migration (`20261102000000_module01_admin_mfa`) adds `mfaVerifiedAt` as NULL to
  every existing session and refresh token, so no pre-existing session counts as MFA-verified, and it
  increments `permVersion` for every platform administrator. After deployment, every administrator
  access token is rejected (`TOKEN_EXPIRED`), the refresh that follows is rejected
  (`AUTH_MFA_REQUIRED`) and its family revoked, and the administrator signs in again with MFA. Even
  without the version bump, the guard rejects any administrator token without `mfa: true`.
- **Promotion.** Granting ADMIN or SUPER_ADMIN through the API bumps `permVersion`, so the user's
  current access token stops working. Their refresh token has no MFA assurance and is refused, so the
  next sign-in requires MFA enrolment. A role written directly to the database is still caught by the
  guard within the 30-second cache window.
- **Authenticator replacement** (below) revokes every session and refresh token of the account and
  bumps `permVersion`.

## Recovery codes

- Ten codes, each 80 random bits (`ABCD-EFGH-IJKL-MNOP`), shown once after enrolment.
- Stored only as SHA-256 hashes. At 80 bits a fast hash can't be brute-forced; case, spaces and
  dashes are ignored when entered.
- Single use, consumed atomically.
- **Rotation:** `POST /auth/mfa/recovery-codes/rotate` `{ code }` with a normal (MFA) access token
  **and** a current authenticator code (replay rules apply) replaces all codes and returns the new
  set once. A stolen access token alone can't mint recovery codes.
- `GET /auth/mfa/status` returns `{ required, enrolled, enabledAt, recoveryCodesRemaining }`, never
  any secret.

### Lost authenticator

1. Sign in with the password (TOTP challenge).
2. `POST /auth/mfa/recovery` `{ challengeToken, recoveryCode }`. The code and the challenge are
   consumed together. The response is **not a session**: it is an enrolment challenge with
   `reason: "RECOVERY"`. A wrong code counts against the challenge's five attempts.
3. Enrol a new authenticator (start, then confirm). Confirmation replaces the old authenticator,
   issues ten fresh recovery codes, revokes every existing session and refresh token, and only then
   issues the new session.

A recovery code is never an MFA bypass on its own. There is **no HTTP endpoint that disables MFA**.

### Emergency: authenticator and all recovery codes lost

There is no master code and no bypass. The controlled procedure is an operator action against the
database, performed by two people, with the account owner's identity confirmed out of band:

1. Confirm the request through an independent channel, and record who approved it.
2. In a transaction, delete that user's row from `admin_mfa_credentials` and their rows from
   `admin_mfa_recovery_codes`, revoke their sessions and refresh tokens (`revokedAt = now()`), and
   increment their `users.permVersion`.
3. Record the action in the audit log (an `INSERT` through the application's audit conventions, or a
   ticket referenced from it).
4. The administrator then signs in with their password and is required to enrol a new authenticator.

Because the password then becomes the only factor until enrolment completes, do this only when the
password is known to be uncompromised, and consider resetting it first (`POST /auth/password/forgot`).
For a lost Super Admin, another Super Admin can instead remove the user's SUPER_ADMIN role, which
does not need this procedure.

## Encryption key

Authenticator secrets must be readable by the server to verify later codes, so they are encrypted,
not hashed: AES-256-GCM under `ADMIN_MFA_ENCRYPTION_KEY`, with a fresh 96-bit IV per secret and the
user id as authenticated data, so a ciphertext copied to another account doesn't decrypt. Stored as
`v1.<iv>.<tag>.<ciphertext>`. The key is never stored in the database.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- 32 random bytes, standard base64 (44 characters ending in `=`). Malformed, placeholder-like
  (fewer than 16 distinct bytes) or reused (a copy of a JWT secret, `MASTER_ENCRYPTION_KEY` or
  `OTP_HASH_SECRET`) values are rejected. Error messages never contain the value.
- **Production:** required; the process refuses to start without a valid key. There is no fallback.
- **Elsewhere:** optional. Without it the server starts, but administrator MFA fails closed
  (`DEPENDENCY_UNAVAILABLE`): no administrator can enrol or sign in. The e2e harness generates a
  throwaway key per run.
- Provision it from a secret manager into the backend's environment only. Never commit it, never put
  a real value in `.env.example`, never share it in chat or tickets. Every instance must have the same key.

### Rotation

There is no online re-encryption yet. Changing the key makes every stored secret unreadable, so
rotate by: generating the new key; deploying it; then requiring every administrator to re-enrol (the
emergency procedure above, for all administrators), which re-encrypts under the new key. The `v1`
prefix leaves room for a future format that records a key id and supports a previous key for
decryption. Rotate immediately if the key may have leaked; a leaked key plus a database copy exposes
every authenticator secret.

## Audit events

Recorded in the hash-chained audit log; none contains a secret, URI, code, challenge token, password
or key:

| Action | When |
|---|---|
| `identity.mfa.challenge_issued` | Password accepted; `context.purpose` is `ENROLL` or `VERIFY` |
| `identity.mfa.enrollment_started` | Setup key generated |
| `identity.mfa.enrollment_completed` | Authenticator enabled (`context.replacement`) |
| `identity.mfa.authenticator_replaced` | Replacement after a recovery code |
| `identity.mfa.challenge_succeeded` | Authenticator code accepted |
| `identity.mfa.challenge_failed` | Wrong/replayed code (`context.step`, `context.reason`) |
| `identity.mfa.recovery_code_used` | Recovery code accepted |
| `identity.mfa.recovery_codes_rotated` | Codes replaced |
| `identity.mfa.privileged_session_blocked` | OTP auto-login or refresh refused (`context.path`) |

Login history records `MFA_REQUIRED` at the password step, `SUCCESS` when MFA completes, and `FAILED`
with an `MFA_*` reason for a rejected code.

## E-mail verification is not MFA

Verifying an e-mail address (the registration OTP) proves that someone controls that inbox. It sets
`emailVerifiedAt` and activates a pending account. It is not a second factor: an administrator who
verifies an e-mail code still has no session until the authenticator step. It is also not Fayda
identity verification, and never sets `faydaVerifiedAt`.

## Production prerequisites

Administrator MFA is enforced in code and by tests, but production readiness also needs:

- `ADMIN_MFA_ENCRYPTION_KEY` provisioned from a secret manager, identical on every instance;
- the Work 66 migration applied (`npx prisma migrate deploy`);
- Resend credentials and a shared Redis (`OTP_STORE=redis`), for the first Super Admin's e-mail
  verification;
- an agreed owner and runbook for the emergency recovery procedure;
- a review of the rate limits for the deployment's proxy setup (`TRUST_PROXY`).

The other production blockers recorded in earlier work (pharmacy licence approval and activation
gates, SMS and Fayda providers) are unchanged by this work.
