# Support impersonation ("view as") — Work 85

module-16 F-AD-08 and §9.2 (`POST /admin/users/{id}/impersonate` — "gated + maker-checker + heavily
audited"), shared conventions §9 ("strictly gated + heavily audited"). Module-16 open question 3 asked
whether it is allowed at all and under what consent; the owner asked for the recommended answer,
which is below and can be revisited.

## Decisions (Work 85)

1. **Allowed, read-only.** A view-as token can only make GET/HEAD requests; anything else is
   `IMPERSONATION_READ_ONLY` (403). Support can see what the account holder sees, never act for them.
2. **Two administrators, always.** `IMPERSONATION_START` is a maker-checker action (Work 82) and
   Module 01 refuses a session the requester approved themselves, so switching the action off in
   `approvals.makerCheckerActions` makes impersonation impossible rather than single-actor.
3. **Never a platform account, never oneself, never an inactive account** (`IMPERSONATION_NOT_ALLOWED`).
   A platform account is any account holding a PLATFORM-scope role (Admin, Super Admin, Finance Officer,
   Customer Support). Checked when asked, when authorized and again when started.
4. **Short and single-use.** The requester (only they — not the approver) starts an approved session
   within 15 minutes and receives one access token valid for 15 minutes, with no refresh token. A
   session starts once; ending it (`POST /admin/impersonation-sessions/{id}/end`, requester or approver)
   revokes the token at once — `JwtAuthGuard` checks the session on every request.
5. **Consent by notice.** Starting a session sends the account holder an in-app security notification
   (`ACCOUNT_IMPERSONATED`, English and Amharic): support is viewing the account read-only for up to
   15 minutes. It does not name the administrator; the audit log does.
6. **Audited per request.** `IMPERSONATION_AUTHORIZED`, `IMPERSONATION_STARTED`, `IMPERSONATION_ENDED`,
   and `IMPERSONATED_REQUEST` for every request made with the token (method and path, never bodies or
   query strings), with the administrator as actor and the account as target — plus Work 82's approval
   entries with both administrators.
7. **Permission** `support:impersonate:any`: ADMIN only (SUPER_ADMIN by wildcard).

## Flow

1. `POST /admin/accounts/{id}/impersonate` `{ reason }` (`Idempotency-Key`) → 202 `MAKER_CHECKER_PENDING`.
2. A different administrator approves on the Approvals page → Module 01 authorizes a session for the
   requester.
3. `POST /admin/impersonation-sessions/{id}/start` → `{ accessToken, expiresAt }` (15 minutes).
4. Reads with the token (`GET /users/me`, `GET /orders`, …). The portal's Accounts drawer does this in
   a dialog and keeps the token in memory only.
5. `POST /admin/impersonation-sessions/{id}/end`, or it expires.

`GET /admin/impersonation-sessions` lists the caller's sessions (`?mine=false` for everyone's,
`?targetUserId=`).

## Token

An ordinary access token for the account (`sub` = the account, its own permissions and permission
version) plus `imp: { sid, act }`. Because the account's permission version is inside it, a role change
on the account also invalidates the token.

## Not built

- Writing on the holder's behalf (e.g. placing an order for them).
- Health-record access under impersonation: Modules 10–12 are out of scope; when they exist, their
  purpose-bound access rules (NFR-PRIV) apply on top of this.
