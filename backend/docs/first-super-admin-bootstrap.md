# First Super Admin bootstrap (Work 65, Work 66)

A fresh PharmaLink database has roles and permissions (from the RBAC seed) but no administrator.
Customers can sign up; staff can't, and role assignment needs an administrator who already holds
`rbac:manage`. This one-time, operator-only command creates the first Super Admin without writing
to the database by hand.

It runs only where mandatory administrator MFA works (Work 66): the encryption key is configured
and the MFA migration is applied. That is checked in every environment, production included; see
"Production".

## Why it is operator-only

- It is a CLI command, not an HTTP route. No request, authenticated or not, can reach it.
- It runs in a backend environment the operator controls, with database access. It starts a Nest
  application context (providers only), never an HTTP listener, and runs no background jobs: no
  outbox relay and no licence-expiry job.
- It takes no arguments. The e-mail address and password are typed interactively, and the password
  is read twice without being echoed. It refuses to run without an interactive terminal, so a
  password can't come from a pipe, a script or shell history.
- It prints no secret: not the password, its hash, the verification code or any token. Only a
  masked e-mail address and the new user's id.

## Preconditions

The command checks all of these before asking for credentials, and stops without writing anything
if one fails:

| Check | Fix |
|---|---|
| Administrator MFA enforcement is active | Always true: it has no switch. Listed because the command checks it |
| `ADMIN_MFA_ENCRYPTION_KEY` is configured and valid | Generate and provision it ([admin-mfa.md](admin-mfa.md#encryption-key)). Production refuses to start without it anyway |
| The administrator MFA migration (`20261102000000_module01_admin_mfa`) is applied | `npx prisma migrate deploy` |
| The `SUPER_ADMIN` role exists, is PLATFORM-scoped and holds the `*` permission | Run the RBAC seed: `npm run prisma:seed`. The command never creates roles or permissions itself |
| The one-time bootstrap has not been used on this database | It can't be repeated; see "One-time" |
| No user has `primaryRole = SUPER_ADMIN` and no `SUPER_ADMIN` assignment exists | An existing Super Admin without a bootstrap record is a state for an operator to review, not a reason to create another |
| E-mail delivery is configured: `RESEND_API_KEY` and `RESEND_FROM_EMAIL` | Set both, without committing them (`backend/.env.example`) |
| The OTP store is shared and reachable: `OTP_STORE=redis`, the **same** `REDIS_URL` and `OTP_HASH_SECRET` as the running backend | The command issues the code and the server verifies it, so they must share the store. The in-memory store is refused |

It then validates the e-mail address, applies the normal password policy (8+ characters with upper
case, lower case and a digit), and refuses an e-mail address that already has an account.

## Running it

Apply the migrations and the seed first:

```bash
npx prisma migrate deploy
npm run prisma:seed
```

Then, in an interactive terminal, in an environment with the same `DATABASE_URL`, `REDIS_URL`,
`OTP_STORE=redis`, `OTP_HASH_SECRET`, `ADMIN_MFA_ENCRYPTION_KEY` and Resend settings as the backend:

```bash
npm run admin:bootstrap-super-admin
```

From a built backend (`dist/`), the same command is `node dist/cli/bootstrap-super-admin.js`.

In the local staging stack (`compose.staging.yml`), the `tools` service already has the stack's
database and Redis, `OTP_STORE=redis` and the env file (add `ADMIN_MFA_ENCRYPTION_KEY` to
`backend/.env.staging` first; it is not generated for you):

```bash
docker compose -f compose.staging.yml --env-file backend/.env.staging --profile tools run --rm tools npm run admin:bootstrap-super-admin
```

Exit codes: `0` created and the e-mail sent; `2` refused, nothing created; `3` created but the
e-mail was not sent (see below); `1` an unexpected error.

## What it creates

In one Serializable transaction:

- a user with `primaryRole = SUPER_ADMIN`, `status = PENDING_VERIFICATION`, the canonical
  (lower-case) e-mail address, the password hashed by the backend's hasher, `emailVerifiedAt = null`
  and `faydaVerifiedAt = null`;
- a global `SUPER_ADMIN` role assignment (`organizationId = null`, `assignedBy = null`);
- the one-time `platform_bootstrap` record;
- an audit entry, `identity.platform.super_admin_bootstrapped`, with the user id, the assignment id
  and the masked e-mail address.

It does not write a `UserRegistered` event. That event's handler would send a second code, and
Profiles would create a customer profile for an administrator.

## Verifying the account

After the transaction, the command sends **one** registration code by e-mail, through the same
OTP and notification path that registration and resend use (Work 60 store, Work 62 delivery). The
account can't sign in until the code is verified through the normal API:

```http
POST /auth/verify-otp
{ "identifier": "<the e-mail address>", "code": "<code from the e-mail>", "purpose": "REGISTER" }
```

Verification marks the e-mail verified and activates the account. It does not mark Fayda verified:
an e-mail address is not an identity check. It also issues **no session**, even with `deviceInfo`:
the response is `{ "verified": true, "mfaRequired": true }`. Verifying an e-mail address is not the
administrator's second factor.

## Signing in for the first time

1. `POST /auth/login` with the e-mail address and password returns an MFA **enrolment challenge**,
   not tokens.
2. `POST /auth/mfa/enrollment/start` returns the authenticator setup key; add it to an authenticator
   app.
3. `POST /auth/mfa/enrollment/confirm` with the app's code returns the first Super Admin session and
   ten one-time recovery codes. Store them offline.

The web operations portal walks through the same steps. From then on every sign-in needs the
authenticator code. See [admin-mfa.md](admin-mfa.md).

## When the e-mail isn't delivered

If Resend is not configured, the command refuses before writing anything.

If the provider doesn't accept the message after the account was created, the command says the
e-mail was **not** sent and exits with `3`:

- the account stays `PENDING_VERIFICATION` and can't sign in;
- the bootstrap stays consumed, so a second bootstrap can't create another administrator;
- the code that was issued but not delivered keeps its resend cooldown (30 seconds by default).
  After it, request a new code with the normal flow:

```http
POST /auth/resend-otp
{ "identifier": "<the e-mail address>", "purpose": "REGISTER" }
```

## One-time

The `platform_bootstrap` table holds at most one row. Its primary key must be `FIRST_SUPER_ADMIN`
(a CHECK constraint), and a trigger refuses any UPDATE or DELETE. The row is written in the same
transaction as the account, so:

- a second run is refused, even if the first Super Admin was later suspended, demoted or deleted;
- two concurrent runs can't both succeed. Serializable isolation makes the loser abort and retry,
  and on retry it sees the completed bootstrap. The marker's primary key is the last line of defence;
- the RBAC seed and role administration never touch it.

Restoring the ability to bootstrap would mean editing the database by hand, which is deliberately
not supported.

## Production

Work 65 refused `NODE_ENV=production` outright because administrator MFA didn't exist. Work 66
replaced that refusal with the checks it was standing in for: enforcement is active (it can't be
turned off), `ADMIN_MFA_ENCRYPTION_KEY` is valid, and the MFA migration is applied. The command runs
in production only when they hold, and in no environment can the new Super Admin get a session
without enrolling an authenticator.

Production bootstrap sequence:

1. Provision `ADMIN_MFA_ENCRYPTION_KEY`, Resend credentials, `REDIS_URL`, `OTP_STORE=redis` and
   `OTP_HASH_SECRET` from the secret manager, identical to the running backend's.
2. `npx prisma migrate deploy`, then `npm run prisma:seed` (roles and permissions only).
3. Run the command in an interactive shell on a host the operator controls.
4. Verify the e-mail address with the code (`POST /auth/verify-otp`).
5. Sign in and enrol an authenticator; store the recovery codes offline.

Everything else in [admin-mfa.md](admin-mfa.md#production-prerequisites) still applies, and this
command does not make the platform production-ready on its own.
