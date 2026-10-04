# Module 1 — Identity & Authentication (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 01 — Identity & Access Management (IAM)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Traceability:** FR-AC-01..12, FR-PRV-01..04, FR-ADM-09, BRULE-01..04, BRULE-08..09, BRULE-39, NFR-SEC-01..10, NFR-PRIV-01..06, NFR-AUDIT-01..03

> This document is the single source of truth for the Identity & Authentication bounded context. It is detailed enough that a backend engineer can implement it without re-designing. It deliberately contains **no implementation code** — only contracts, schemas, flows, and reasoning.

---

## 1. Module Objectives

The Identity & Authentication module is the **security foundation** of the entire platform. Every other bounded context (Catalog, Order, Payment, Delivery, Appointment, Admin) depends on it to answer three questions:

1. **Authentication** — *Who is this actor?* (Are they who they claim to be?)
2. **Authorization** — *What is this actor allowed to do?* (RBAC + permissions)
3. **Assurance / Identity Verification** — *Is this actor a real, verified person/entity?* (Fayda ID, license verification)

**Primary objectives**
- Provide a **single, trusted identity** per human/organization actor across all client apps (Customer Flutter, Driver Flutter, Pharmacy React, Admin React).
- Enforce **least-privilege RBAC** consistently across the whole platform via one authorization mechanism.
- Guarantee **regulatory-grade identity assurance** (Fayda ID for regulated roles) before privileged actions (BRULE-01, BRULE-09).
- Deliver **enterprise security**: token security, brute-force protection, device/session control, and a **tamper-evident audit trail** (BRULE-39, NFR-AUDIT).
- Be **horizontally scalable and stateless** at the API tier to support ≥ 5M users (NFR-SCAL-02).

**Design rationale.** Authentication is a *cross-cutting capability*, but identity data is a *bounded context* with its own aggregate roots (User, Role, VerificationRequest). We keep it as an owned domain with a clean interface so that later extraction into a dedicated Auth microservice requires no rewrite of consumers — they already depend on an abstraction (`IdentityService` port + JWT contract), not on tables.

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-IAM-01 | Users must register using phone number and/or email. | FR-AC-01 |
| BR-IAM-02 | Users must verify identity via Fayda ID before regulated actions. | FR-AC-02, BRULE-01 |
| BR-IAM-03 | OTP verification must be supported for registration and login. | FR-AC-03 |
| BR-IAM-04 | Accounts must be role-based across all actor types. | FR-AC-04 |
| BR-IAM-05 | Users must be able to reset passwords and recover accounts securely. | FR-AC-06 |
| BR-IAM-06 | An account has exactly one primary role but may hold linked provider roles subject to verification. | BRULE-02 |
| BR-IAM-07 | Minors must be managed by a verified adult guardian. | BRULE-03 |
| BR-IAM-08 | Access to health records is restricted to owner, authorized beneficiaries, and verified providers. | BRULE-04 |
| BR-IAM-09 | Providers (pharmacy, doctor, lab, driver) must be verified before transacting. | FR-PRV-02..04, BRULE-05..09 |
| BR-IAM-10 | Providers with expired licenses are automatically suspended. | BRULE-08, FR-PRV-09 |
| BR-IAM-11 | Sessions must time out and require secure re-authentication. | FR-AC-10 |
| BR-IAM-12 | Users must be able to view login history and active sessions. | FR-AC-11 |
| BR-IAM-13 | The platform must support account deactivation and data-deletion requests. | FR-AC-12, NFR-PRIV-04 |
| BR-IAM-14 | Role and permission management must be available to admins. | FR-ADM-09 |
| BR-IAM-15 | All sensitive identity actions must be recorded in an immutable audit trail. | BRULE-39, FR-ADM-05 |
| BR-IAM-16 | MFA/OTP must be enforceable for sensitive actions. | NFR-SEC-06 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Registration
- **F-REG-01** Register as Customer via phone (primary) and/or email + password.
- **F-REG-02** Register as Provider (pharmacy owner, doctor, driver, lab/hospital staff) with role-specific onboarding + credential upload.
- **F-REG-03** Duplicate detection (phone/email/Fayda already registered).
- **F-REG-04** Staff accounts (pharmacist, cashier, inventory, hospital/lab staff) are **invited** by an organization owner/admin, not self-registered.
- **F-REG-05** Guardian-managed minor accounts (BRULE-03) linked to a verified adult.

### 3.2 Verification
- **F-VER-01** Phone verification via OTP (SMS).
- **F-VER-02** Email verification via signed tokenized link + optional OTP.
- **F-VER-03** Fayda ID identity verification (regulated roles) — see §9.
- **F-VER-04** License/credential verification for providers (admin-reviewed).
- **F-VER-05** Resend OTP / resend email with rate limits and cooldown.

### 3.3 Login / Session
- **F-LOG-01** Login with phone+password or email+password.
- **F-LOG-02** Login with OTP (passwordless) for customers.
- **F-LOG-03** Google OAuth login (customer app).
- **F-LOG-04** Biometric login (device-bound; unlocks a stored refresh token, see §8).
- **F-LOG-05** MFA/step-up authentication for sensitive actions (NFR-SEC-06).
- **F-LOG-06** Logout (current device) and logout-all (revoke all sessions).
- **F-LOG-07** Access-token issuance + refresh-token rotation.
- **F-LOG-08** Session timeout / idle expiry + forced re-authentication.

### 3.4 Account Recovery
- **F-REC-01** Password reset via OTP (phone) or signed email link.
- **F-REC-02** Account recovery when device lost (revoke devices, re-verify identity).
- **F-REC-03** Change password (authenticated) with old-password confirmation.

### 3.5 Device & Session Management
- **F-DEV-01** Register device on first login (device fingerprint + FCM token).
- **F-DEV-02** List, name, and revoke trusted devices.
- **F-DEV-03** View active sessions and login history (FR-AC-11).
- **F-DEV-04** Bind refresh tokens to a device; revoke on device removal.

### 3.6 Roles & Permissions
- **F-RBAC-01** Assign primary role at registration; link secondary provider roles post-verification (BRULE-02).
- **F-RBAC-02** Admin console for role/permission management (FR-ADM-09).
- **F-RBAC-03** Organization-scoped roles (staff belong to a specific pharmacy/hospital/lab tenant).

### 3.7 Profile & Lifecycle
- **F-PRF-01** Create/edit profile (contact, language preference Amharic/English — FR-AC-09).
- **F-PRF-02** Deactivate / reactivate / delete account (FR-AC-12).
- **F-PRF-03** Account status transitions (see §4 state machine).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Security** | TLS 1.2+, AES-256 at rest, OWASP Top 10, RBAC least-privilege (NFR-SEC-01..05) | Argon2id hashing, short-lived JWT, rotating refresh tokens, input validation, parameterized queries via Prisma, output encoding. |
| **Scalability** | 5M users, auto-scale (NFR-SCAL-01..02) | Stateless API nodes; session/OTP state in Redis; DB read replicas; partition-ready audit/login-history tables. |
| **Performance** | Auth round-trip fast; search ≤ 2s p95 (NFR-PERF) | Redis-cached permission sets; JWT avoids DB hit per request; bcrypt/argon tuned cost. |
| **Reliability/Availability** | 99.9% uptime, RTO ≤ 1h, RPO ≤ 15m (NFR-AVAIL) | Redundant API replicas; DB with PITR & streaming replication; Redis with persistence + replica. |
| **Maintainability** | Modular, documented, CI/CD, config-driven (NFR-MAINT) | Clean Architecture layering; ports/adapters; feature flags; policy config for password/lockout. |
| **Auditability** | Actor/time/context logged, tamper-evident (NFR-AUDIT-01..02) | Append-only `audit_logs` with hash-chaining; write-once storage export. |
| **Privacy/Compliance** | Ethiopian data-protection law, PII segregation, consent, deletion (NFR-PRIV) | PII/health data separation, field-level encryption, consent records, soft-delete + scheduled purge. |
| **Localization** | Amharic/English (NFR-USE-02) | `preferredLanguage` on user; localized OTP/email templates. |

**Account status state machine.**
`PENDING_VERIFICATION → ACTIVE → SUSPENDED → ACTIVE` and `ACTIVE → DEACTIVATED → (purge) DELETED`. Providers add `PENDING_APPROVAL` and `REJECTED`. License expiry drives `ACTIVE → SUSPENDED` automatically (BRULE-08).

---

## 5. User Roles

Roles fall into three scopes: **Platform**, **Organization (tenant) provider**, and **Individual provider**.

| Role | Scope | Purpose |
| --- | --- | --- |
| **Customer** | Individual | End user: browse, order medicines, upload prescriptions, book appointments/tests, manage beneficiaries. |
| **Pharmacy Owner** | Org (Pharmacy) | Legal owner of a pharmacy tenant; completes Fayda + license verification; manages staff, catalog, settlements. |
| **Pharmacy Manager** | Org (Pharmacy) | Runs day-to-day pharmacy ops; manages staff, orders, inventory; cannot alter legal/bank/ownership settings. |
| **Pharmacist** | Org (Pharmacy) | Licensed professional who **verifies prescriptions** and approves dispensing (BRULE-10, BRULE-14). |
| **Cashier** | Org (Pharmacy) | Processes order payments/receipts at pharmacy; limited to transaction handling. |
| **Inventory Staff** | Org (Pharmacy) | Manages stock levels, batches, expiry; no financial/verification rights. |
| **Driver** | Individual provider | Delivery partner; Fayda-verified; accepts and fulfills delivery jobs (BRULE-09). |
| **Doctor** | Individual/Org | Licensed physician; manages availability, appointments, consultation. |
| **Hospital Administrator** | Org (Hospital) | Manages hospital profile, departments, affiliated doctors, staff. |
| **Diagnostic Center Administrator** | Org (Lab) | Manages lab/diagnostic profile, test catalog, bookings, results release. |
| **Customer Support** | Platform | Assists users; can view accounts/orders (masked sensitive data), assist recovery; cannot change financials. |
| **Finance Officer** | Platform | Manages settlements, refunds, payout reconciliation, financial reports. |
| **Admin** | Platform | Operates verification queues, suspends/reactivates accounts, moderates content, manages roles. |
| **Super Admin** | Platform | Highest authority: manages admins, global config, security policies, break-glass access. Actions always audited. |

**Design rationale — one user, many memberships.** A person is one `User`. Their capabilities come from **role assignments** that may be *global* (platform) or *scoped to an organization* (tenant). This is why `user_roles` carries an optional `organizationId`. It cleanly supports BRULE-02 (one primary role + linked provider roles) and multi-tenant staff (a pharmacist could work at two pharmacies).

---

## 6. Permissions (RBAC Model)

### 6.1 Model
We use **RBAC with fine-grained permissions**, structured as `resource:action` strings, grouped and assigned to roles. Permissions resolve to a flat set per request, cached in Redis.

- **Permission** = `resource:action[:scope]` — e.g., `prescription:verify`, `order:read:own`, `user:suspend`.
- **Role → Permissions** = many-to-many (`role_permissions`).
- **User → Roles** = many-to-many, optionally org-scoped (`user_roles`).
- **Effective permissions** = union of all roles' permissions, filtered by scope (`own` / `org` / `any`).

**Why RBAC + scoped permissions (not pure ABAC).** RBAC is predictable, auditable, and easy for admins to reason about — essential in a regulated healthcare context. We add lightweight **scope qualifiers** (`own`/`org`/`any`) to get most of ABAC's flexibility (row-level ownership, tenant isolation) without the complexity of a full policy engine. This can evolve into ABAC/OPA later behind the same guard interface (open/closed principle).

### 6.2 Permission Catalog (representative, extensible per module)

| Permission | Description | Roles |
| --- | --- | --- |
| `auth:login` | Authenticate | All |
| `profile:read:own` / `profile:update:own` | Manage own profile | All |
| `beneficiary:manage:own` | Manage family members | Customer |
| `order:create:own` | Place orders | Customer |
| `order:read:own` | View own orders | Customer |
| `prescription:upload:own` | Upload prescriptions | Customer |
| `prescription:verify` | Approve/reject prescriptions | Pharmacist |
| `catalog:manage:org` | Manage products/prices | Pharmacy Owner, Manager |
| `inventory:manage:org` | Manage stock/batches | Inventory Staff, Manager, Owner |
| `order:read:org` / `order:fulfill:org` | Handle pharmacy orders | Owner, Manager, Pharmacist, Cashier |
| `payment:collect:org` | Process payment/receipt | Cashier |
| `staff:manage:org` | Invite/manage staff | Owner, Manager (limited) |
| `settlement:read:org` | View settlements | Owner |
| `delivery:accept:own` / `delivery:update:own` | Handle delivery jobs | Driver |
| `appointment:manage:own` | Manage own schedule/appointments | Doctor |
| `hospital:manage:org` | Manage hospital profile/staff | Hospital Admin |
| `lab:manage:org` / `labresult:release:org` | Manage lab, release results | Diagnostic Center Admin |
| `support:account:read` | View accounts (masked) | Customer Support |
| `support:recovery:assist` | Assist account recovery | Customer Support |
| `finance:refund:any` / `finance:settlement:any` | Refunds & settlements | Finance Officer |
| `finance:report:any` | Financial reports | Finance Officer, Admin, Super Admin |
| `user:suspend:any` / `user:reactivate:any` | Suspend/reactivate accounts | Admin, Super Admin |
| `provider:verify:any` | Approve provider verification | Admin, Super Admin |
| `verification:queue:read` | View verification queues | Admin, Super Admin |
| `review:moderate:any` | Moderate reviews | Admin, Super Admin |
| `rbac:manage` | Manage roles/permissions | Super Admin (Admin: read-only) |
| `config:manage:global` | Global platform config | Super Admin |
| `admin:manage` | Manage admin accounts | Super Admin |
| `audit:read:any` | Read audit logs | Super Admin (Admin: scoped) |

**Guarding.** A single `PermissionsGuard` reads required permissions from a `@RequirePermissions(...)` decorator on each endpoint and checks against the user's cached effective set (including scope). Scope enforcement (`own`/`org`) is validated in the application layer against resource ownership/tenant.

---

## 7. Authentication Flows (per actor)

Common building blocks: **Access Token (JWT, 15 min)**, **Refresh Token (opaque, 30 days, rotating, device-bound)**, **OTP (Redis, 5 min TTL)**.

### 7.1 Customer (Flutter)
1. **Register** — phone (+ optional email), password. → account `PENDING_VERIFICATION`.
2. **Verify** — OTP sent via SMS; on success phone marked verified, status → `ACTIVE`.
3. **Login** — phone+password *or* OTP-passwordless *or* Google OAuth.
4. **Token issuance** — access JWT + refresh token bound to device.
5. **Biometric** — device stores refresh token in secure enclave/keystore; biometric unlock exchanges it for new access token.
6. **Fayda step-up** — required only when performing regulated action (buying Rx) — not at signup (BRULE-01).
7. **Refresh / Logout / Recovery** — see §7.5–7.7.

### 7.2 Pharmacy (React Portal)
1. **Owner registers** organization + owner account.
2. **Fayda verification** of owner (§9) + **license upload** for the pharmacy.
3. **Admin approval** → org status `ACTIVE`; owner may now **invite staff** (manager, pharmacist, cashier, inventory).
4. **Staff accept invite** → set password → verify email/phone → org-scoped role assigned.
5. **Login** email+password + **mandatory MFA/OTP** for owner/manager (privileged) — NFR-SEC-06.
6. License expiry → org auto-`SUSPENDED` (BRULE-08); transacting blocked until renewed.

### 7.3 Driver (Flutter)
1. **Register** phone + password.
2. **Phone OTP** verification.
3. **Fayda identity verification** + document upload (license/national ID, vehicle info) — §9, BRULE-09.
4. **Admin approval** → status `ACTIVE`; may accept jobs.
5. **Login** phone+password or biometric; device-bound refresh token.

### 7.4 Admin / Super Admin (React Dashboard)
1. **Provisioned** by Super Admin (no self-registration).
2. **Login** email+password + **mandatory MFA (OTP/TOTP)** — always.
3. **Short session** (shorter access TTL, stricter idle timeout).
4. **Step-up re-auth** for high-risk actions (suspensions, RBAC changes, config). All actions audited.

### 7.5 Token Refresh (all actors)
- Client sends refresh token → server validates (exists, not revoked, matches device) → **rotates** (issues new refresh, revokes old — one-time use) → returns new access + refresh.
- **Reuse detection**: if a revoked/used refresh token is presented, treat as theft → revoke entire token family + force re-login + audit alert.

### 7.6 Logout
- **Single**: revoke current device's refresh token; access token expires naturally (short TTL) or is denylisted in Redis if immediate revocation needed.
- **All**: revoke all refresh tokens for the user; clear cached permissions.

### 7.7 Password Recovery
- Request reset → identify by phone/email → send OTP (phone) or signed short-lived link (email) → verify → set new password (policy-checked) → **revoke all sessions** → notify user via all channels (security event).

---

## 8. Security Design

| Control | Design | Reason |
| --- | --- | --- |
| **Password hashing** | **Argon2id** (memory-hard) with per-user salt; configurable cost. bcrypt acceptable fallback. | Resist GPU brute-force; future-proof over bcrypt. |
| **Access token** | JWT (RS256, asymmetric), 15-min TTL, claims: `sub`, `roles`, `permVersion`, `deviceId`, `sessionId`, `iss`, `aud`, `exp`, `jti`. | Stateless verification; asymmetric keys let other services verify without the signing secret. |
| **Refresh token** | Opaque random 256-bit, **hashed at rest**, rotating, one-time-use, device-bound, 30-day TTL. | Opaque = revocable; rotation + reuse detection defeats token theft. |
| **Permission versioning** | `permVersion` claim; bumping it (role change) invalidates old access tokens early. | Immediate authorization changes without long denylists. |
| **OTP** | 6-digit, Redis with 5-min TTL, max 5 attempts, hashed, single-use, per-purpose (login/register/reset). | Prevent OTP brute-force & replay. |
| **Device registration** | Device fingerprint + FCM token stored; refresh token bound to `deviceId`. | Enables per-device revocation & anomaly detection. |
| **Session management** | Session record per (user, device); idle + absolute timeout; list/revoke sessions. | User visibility + control (FR-AC-11). |
| **Rate limiting** | Redis sliding-window per IP + per identifier on `/auth/*` (login, OTP, reset). | Throttle credential stuffing / OTP flooding. |
| **Account lockout** | Progressive: after N failed logins → temporary lock with exponential backoff; notify user. | Brute-force protection without permanent DoS. |
| **Brute-force protection** | Combine lockout + rate limit + CAPTCHA challenge after threshold. | Layered defense. |
| **CSRF** | Bearer tokens in `Authorization` header (not cookies) for SPA/mobile → CSRF N/A. If cookies ever used (admin), enforce SameSite=strict + CSRF token. | Header tokens sidestep CSRF. |
| **XSS prevention** | Never store tokens in `localStorage` for admin (use in-memory + httpOnly refresh cookie option); strict output encoding; CSP headers. | Protect tokens from script theft. |
| **SQL injection** | Prisma parameterized queries only; no raw string interpolation; validated DTOs. | Eliminate injection vectors. |
| **Transport** | TLS 1.2+ everywhere; HSTS. | NFR-SEC-01. |
| **Secrets** | Signing keys + provider secrets in vault/KMS, rotated; never in code/repo. | Key hygiene. |
| **Audit logging** | Append-only, hash-chained `audit_logs` for every sensitive action. | Tamper-evidence (NFR-AUDIT-02). |
| **PII protection** | Field-level encryption for Fayda ID number, national ID; PII segregated from health data. | NFR-PRIV-06. |

**Token storage per client**
- **Flutter (customer/driver):** access token in memory; refresh token in secure storage (Keychain/Keystore), unlocked by biometrics.
- **React (pharmacy/admin):** access token in memory; refresh token in httpOnly, Secure, SameSite=strict cookie (mitigates XSS token theft).

---

## 9. Fayda ID Integration

Fayda is Ethiopia's national digital ID. It provides **identity assurance** for regulated roles. We integrate it via a **pluggable adapter** (`IdentityVerificationProvider` port) so we can mock in dev and swap providers without touching domain logic.

### 9.1 Who must verify
- **Pharmacy Owners** — before the pharmacy can be approved to transact (BRULE-05 chain, FR-PRV-04).
- **Drivers** — before accepting delivery jobs (BRULE-09).
- **Customers** — *step-up* only when purchasing Rx/regulated medicines (BRULE-01), not at signup.

### 9.2 Verification workflow
1. **Initiate** — user submits Fayda ID number (FIN/FAN) + consent.
2. **Provider check** — adapter calls Fayda verification API (or OTP-to-registered-phone / biometric flow as the provider supports).
3. **Document upload** — role-specific documents to Cloud Storage (encrypted):
   - *Pharmacy Owner:* Fayda ID, pharmacy business license, professional license, TIN.
   - *Driver:* Fayda ID, driving license, vehicle registration, photo.
4. **Data match** — verify name/DOB from Fayda match submitted profile.
5. **Create `VerificationRequest`** with status `PENDING`.
6. **Admin review** — admin views queue (`verification:queue:read`), approves/rejects with reason (`provider:verify:any`).
7. **Outcome** — `APPROVED` → identity flag set, role activated; `REJECTED` → reason recorded, user notified, may resubmit.
8. **Audit** — every state change logged (BRULE-39).

### 9.3 Verification status
`NOT_STARTED → PENDING → UNDER_REVIEW → APPROVED | REJECTED | EXPIRED`. License documents carry an `expiresAt`; a scheduled job flips provider to `SUSPENDED` on expiry (BRULE-08).

### 9.4 Approval process & separation of duties
- Automated checks (Fayda match, document presence) gate submission.
- **Human admin** performs final approval — required for regulated healthcare compliance.
- Fayda ID number is **encrypted at rest** and never returned in API responses (only masked, e.g., `****1234`).

---

## 10. Database Design (PostgreSQL via Prisma)

All tables use UUID v7 primary keys (time-ordered, index-friendly), `created_at`/`updated_at`, and soft-delete (`deleted_at`) where lifecycle applies.

### 10.1 Entities

**users** — the core identity aggregate root.
- `id`, `phone` (unique, nullable), `email` (unique, nullable), `password_hash`, `primary_role` (enum), `status` (enum), `preferred_language`, `phone_verified_at`, `email_verified_at`, `fayda_verified_at`, `guardian_id` (self-FK, nullable — BRULE-03), `perm_version` (int), `created_at`, `updated_at`, `deleted_at`.
- *Purpose:* single record per human actor; holds credentials & verification flags.

**organizations** — tenant for provider staff (pharmacy/hospital/lab).
- `id`, `type` (PHARMACY|HOSPITAL|CLINIC|LAB), `name`, `status`, `owner_user_id` (FK users), `license_number`, `license_expires_at`, `created_at`...
- *Purpose:* multi-tenant boundary; staff roles are scoped to an organization.

**roles** — catalog of roles.
- `id`, `key` (unique, e.g., `PHARMACIST`), `name`, `scope` (PLATFORM|ORG|INDIVIDUAL), `is_system` (bool), `description`.

**permissions** — catalog of permissions.
- `id`, `key` (unique, e.g., `prescription:verify`), `resource`, `action`, `scope` (own|org|any), `description`.

**role_permissions** — M:N roles↔permissions.
- `role_id` (FK), `permission_id` (FK). PK composite.

**user_roles** — M:N users↔roles, optionally org-scoped.
- `id`, `user_id` (FK), `role_id` (FK), `organization_id` (FK, nullable), `assigned_by` (FK users), `created_at`. Unique (`user_id`,`role_id`,`organization_id`).
- *Purpose:* implements BRULE-02 (primary + linked roles) and multi-tenant staff.

**sessions** — active authenticated sessions.
- `id`, `user_id` (FK), `device_id` (FK), `ip`, `user_agent`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`.

**refresh_tokens** — rotating device-bound tokens.
- `id`, `user_id` (FK), `device_id` (FK), `token_hash` (unique), `family_id` (uuid — rotation lineage), `expires_at`, `used_at`, `revoked_at`, `replaced_by` (self-FK), `created_at`.
- *Purpose:* rotation + reuse detection (revoke whole `family_id` on reuse).

**devices** — registered devices per user.
- `id`, `user_id` (FK), `fingerprint`, `name`, `platform` (ANDROID|IOS|WEB), `fcm_token`, `is_trusted`, `last_login_at`, `created_at`, `revoked_at`.

**otps** — (primary store Redis; optional cold record for audit).
- `id`, `user_id` (FK, nullable), `identifier` (phone/email), `purpose` (REGISTER|LOGIN|RESET|STEP_UP), `code_hash`, `attempts`, `expires_at`, `consumed_at`, `created_at`.
- *Note:* live OTP flow uses Redis (TTL); this table optionally persists metadata for audit, not the code.

**login_history** — audit of authentication attempts.
- `id`, `user_id` (FK, nullable), `identifier`, `device_id` (FK, nullable), `ip`, `user_agent`, `outcome` (SUCCESS|FAILED|LOCKED|MFA_REQUIRED), `failure_reason`, `created_at`.
- *Purpose:* FR-AC-11 + anomaly detection. Partition by month at scale.

**verification_requests** — Fayda/license verification.
- `id`, `user_id` (FK), `organization_id` (FK, nullable), `type` (FAYDA|PHARMACY_LICENSE|DRIVER_DOCS|DOCTOR_LICENSE), `status`, `fayda_id_encrypted`, `documents` (jsonb — storage refs), `reviewer_id` (FK users, nullable), `reject_reason`, `submitted_at`, `reviewed_at`, `expires_at`.

**audit_logs** — immutable, hash-chained.
- `id`, `actor_user_id` (FK, nullable), `action`, `resource_type`, `resource_id`, `context` (jsonb), `ip`, `prev_hash`, `hash`, `created_at`. Append-only (no update/delete grant).

**consents** — privacy consent records (NFR-PRIV-03).
- `id`, `user_id` (FK), `type`, `granted`, `version`, `created_at`.

### 10.2 Relationships (summary)
- `users 1—N user_roles N—1 roles`; `roles N—N permissions`.
- `users 1—N sessions/refresh_tokens/devices/login_history/verification_requests/consents`.
- `refresh_tokens N—1 devices`; `sessions N—1 devices`.
- `organizations 1—N user_roles` (org-scoped staff); `organizations N—1 users` (owner).
- `users 1—N users` via `guardian_id` (minor→guardian).

**Design rationale.** Separating `sessions`, `refresh_tokens`, and `devices` (rather than one blob) gives independent lifecycles: revoke a device without dropping history, rotate refresh tokens without touching sessions, and audit logins independently. Hash-chaining `audit_logs` makes tampering detectable (each row's `hash = H(prev_hash + row)`).

---

## 11. API Design

Base path: `/api/v1/auth` (+ `/api/v1/users`, `/api/v1/admin/rbac`). All responses use the standard envelope from §14. All timestamps ISO-8601 UTC.

### 11.1 Registration & Verification

**POST `/auth/register`** — Register customer.
- Body: `{ phone?, email?, password, preferredLanguage? }`
- 201: `{ userId, status: "PENDING_VERIFICATION", verification: { channel: "SMS", target: "***1234" } }`
- Auth: none. Errors: 409 `AUTH_DUPLICATE_IDENTIFIER`, 422 `VALIDATION_ERROR`, 429 `RATE_LIMITED`.

**POST `/auth/verify-otp`** — Verify phone/email OTP.
- Body: `{ identifier, code, purpose }`
- 200: `{ verified: true, tokens?: {...} }` (tokens if purpose=LOGIN/REGISTER auto-login)
- Errors: 400 `AUTH_OTP_INVALID`, 410 `AUTH_OTP_EXPIRED`, 429 `AUTH_OTP_ATTEMPTS_EXCEEDED`.

**POST `/auth/resend-otp`** — Resend OTP (rate-limited, cooldown).
- Body: `{ identifier, purpose }` → 200 `{ resent: true, cooldownSeconds }`. Error 429.

**POST `/auth/verify-email`** — Confirm signed email link.
- Body: `{ token }` → 200 `{ verified: true }`. Error 400 `AUTH_TOKEN_INVALID`.

### 11.2 Login & Tokens

**POST `/auth/login`** — Password login.
- Body: `{ identifier, password, deviceInfo }`
- 200: `{ accessToken, refreshToken, expiresIn, user }` or 200 `{ mfaRequired: true, challengeId }`.
- Errors: 401 `AUTH_INVALID_CREDENTIALS`, 403 `AUTH_ACCOUNT_SUSPENDED`, 423 `AUTH_ACCOUNT_LOCKED`, 429.

**POST `/auth/login/otp`** — Passwordless (customer): request then verify via `/auth/verify-otp`.
- Body: `{ phone }` → 200 `{ challengeSent: true }`.

**POST `/auth/login/google`** — Google OAuth.
- Body: `{ idToken, deviceInfo }` → 200 tokens. Error 401 `AUTH_OAUTH_INVALID`.

**POST `/auth/mfa/verify`** — Complete MFA challenge.
- Body: `{ challengeId, code }` → 200 tokens. Errors 400/410.

**POST `/auth/token/refresh`** — Rotate tokens.
- Body: `{ refreshToken }` (or httpOnly cookie for web)
- 200: `{ accessToken, refreshToken, expiresIn }`.
- Errors: 401 `AUTH_REFRESH_INVALID`, 401 `AUTH_REFRESH_REUSE_DETECTED` (family revoked).

**POST `/auth/logout`** — Revoke current session. Auth: Bearer. → 204.

**POST `/auth/logout-all`** — Revoke all sessions. Auth: Bearer. → 204.

### 11.3 Account Recovery

**POST `/auth/password/forgot`** — Start reset.
- Body: `{ identifier }` → 200 `{ challengeSent: true }` (always 200 to avoid user enumeration).

**POST `/auth/password/reset`** — Complete reset.
- Body: `{ identifier, code|token, newPassword }` → 200 `{ reset: true }`. Revokes all sessions.
- Errors: 400 `AUTH_OTP_INVALID`, 422 `AUTH_WEAK_PASSWORD`.

**POST `/auth/password/change`** — Authenticated change.
- Body: `{ oldPassword, newPassword }`. Auth: Bearer. → 200. Error 401 `AUTH_INVALID_CREDENTIALS`.

### 11.4 Devices & Sessions

**GET `/auth/sessions`** — List active sessions. Auth: Bearer. → 200 `[{ sessionId, device, ip, lastSeenAt }]`.
**DELETE `/auth/sessions/{id}`** — Revoke a session. Auth: Bearer. → 204.
**GET `/auth/devices`** — List devices. Auth: Bearer. → 200.
**DELETE `/auth/devices/{id}`** — Revoke device (+ its tokens). Auth: Bearer. → 204.
**GET `/auth/login-history`** — Paginated login history. Auth: Bearer. → 200.

### 11.5 Profile & Lifecycle

**GET `/users/me`** — Current profile + effective roles. Auth: Bearer.
**PATCH `/users/me`** — Update profile/language. Auth: Bearer.
**POST `/users/me/deactivate`** — Deactivate account. Auth: Bearer + step-up.
**POST `/users/me/delete-request`** — Data-deletion request (NFR-PRIV-04). Auth: Bearer + step-up.

### 11.6 Verification (Fayda / License)

**POST `/verification/fayda`** — Submit Fayda + consent. Auth: Bearer. → 202 `{ requestId, status: "PENDING" }`.
**POST `/verification/documents`** — Upload provider documents (multipart → storage refs). Auth: Bearer. → 202.
**GET `/verification/status`** — Current verification status. Auth: Bearer.

### 11.7 Admin & RBAC (Auth: Bearer + permission)

**GET `/admin/verification/queue`** — `verification:queue:read`. Paginated pending requests.
**POST `/admin/verification/{id}/approve`** — `provider:verify:any`. → 200. Audited.
**POST `/admin/verification/{id}/reject`** — Body `{ reason }`. `provider:verify:any`. Audited.
**POST `/admin/users/{id}/suspend`** — `user:suspend:any`. Body `{ reason }`. Audited.
**POST `/admin/users/{id}/reactivate`** — `user:reactivate:any`. Audited.
**GET `/admin/rbac/roles`** / **GET `/admin/rbac/permissions`** — `rbac:manage` (read).
**POST `/admin/rbac/roles/{id}/permissions`** — Assign permissions. `rbac:manage` (Super Admin). Audited; bumps `perm_version` of affected users.
**POST `/admin/users/{id}/roles`** — Assign/revoke roles (optionally org-scoped). Audited.

**Standardized error responses** apply to all endpoints — see §14.

---

## 12. NestJS Folder Structure (Clean Architecture)

```
src/
  modules/
    identity/                         # Identity & Auth bounded context
      domain/                         # Enterprise rules — framework-free
        entities/                     # User, Role, Permission, Session, RefreshToken,
        │                             # Device, VerificationRequest, Organization (aggregate roots/entities)
        value-objects/                # Email, PhoneNumber, Password, FaydaId, PermissionKey
        events/                       # UserRegistered, UserVerified, AccountSuspended,
        │                             # RefreshTokenReuseDetected, ProviderApproved
        enums/                        # AccountStatus, RoleScope, VerificationStatus, OtpPurpose
        repositories/                 # PORT interfaces: IUserRepository, IRoleRepository,
        │                             # ISessionRepository, IRefreshTokenRepository, ...
        services/                     # domain services: PermissionResolver, PasswordPolicy
      application/                    # Use cases — orchestration
        commands/                     # RegisterUser, LoginUser, RefreshToken, VerifyOtp,
        │                             # ResetPassword, SubmitFaydaVerification, ApproveVerification,
        │                             # SuspendUser, AssignRole ... (one use case per file)
        queries/                      # GetProfile, ListSessions, GetVerificationStatus, ...
        ports/                        # OUTBOUND interfaces (adapters implement these):
        │                             # ITokenService, IOtpService, IHasher, INotificationPort,
        │                             # IIdentityVerificationProvider (Fayda), IStoragePort,
        │                             # ICachePort, IAuditPort, IOAuthVerifier
        dtos/                         # application-level DTOs
        mappers/                      # domain <-> dto/persistence mapping
      infrastructure/                 # Adapters — framework & IO
        persistence/
          prisma/                     # PrismaService, schema mapping
          repositories/               # PrismaUserRepository implements IUserRepository, ...
        security/                     # JwtTokenService, Argon2Hasher, RefreshTokenService
        cache/                        # RedisOtpService, RedisCacheAdapter, RedisRateLimiter
        providers/                    # FaydaVerificationAdapter, GoogleOAuthVerifier, MockFayda
        messaging/                    # FcmNotificationAdapter, SmsAdapter, EmailAdapter
        audit/                        # HashChainAuditAdapter
        storage/                      # CloudStorageAdapter (documents)
      interface/                      # Inbound adapters — HTTP/WS
        http/
          controllers/                # AuthController, UserController, VerificationController,
          │                           # AdminRbacController, AdminVerificationController
          dtos/                       # request/response DTOs + class-validator rules
          guards/                     # JwtAuthGuard, PermissionsGuard, MfaGuard, ThrottlerGuard
          decorators/                 # @CurrentUser, @RequirePermissions, @Public
          filters/                    # DomainExceptionFilter (maps errors → envelope)
          interceptors/               # AuditInterceptor, LoggingInterceptor
        events/                       # domain-event handlers (e.g., send OTP on UserRegistered)
      identity.module.ts              # wires providers to ports (DI composition root)
  shared/                             # cross-module kernel
    domain/                           # base Entity, AggregateRoot, DomainEvent, Result
    errors/                           # AppError hierarchy, error codes
    config/                           # typed config (env), password/lockout policy
    logging/                          # logger, correlation-id middleware
  main.ts
prisma/
  schema.prisma
  migrations/
test/                                 # unit (domain/application) + e2e (interface)
```

**Rationale.** Dependencies point inward: `interface → application → domain`; `infrastructure` implements `domain`/`application` ports. Domain has **zero** NestJS/Prisma imports (pure, unit-testable). Swapping Fayda provider or Postgres for another store means writing a new adapter — no domain change (Dependency Inversion, Open/Closed).

---

## 13. Sequence Diagrams (event sequences)

### 13.1 Registration (Customer)
```
Client → AuthController: POST /auth/register {phone,password}
AuthController → RegisterUser (use case): execute
RegisterUser → IUserRepository: findByPhone  (duplicate check)
RegisterUser → IHasher: hash(password)
RegisterUser → IUserRepository: save(user, status=PENDING_VERIFICATION)
RegisterUser → emit UserRegistered event
UserRegistered handler → IOtpService: generate+store OTP (Redis, 5m)
UserRegistered handler → INotificationPort: send SMS OTP
RegisterUser → IAuditPort: log(USER_REGISTERED)
AuthController → Client: 201 {userId, status, verification target masked}
```

### 13.2 Login (password + optional MFA)
```
Client → AuthController: POST /auth/login {identifier,password,deviceInfo}
LoginUser → IRateLimiter: check(ip, identifier)   [429 if exceeded]
LoginUser → IUserRepository: findByIdentifier
LoginUser → IHasher: verify(password, hash)        [401 if mismatch → record FAILED]
LoginUser → check status                            [403 suspended / 423 locked]
alt privileged role or step-up:
  LoginUser → IOtpService: issue MFA challenge
  AuthController → Client: 200 {mfaRequired, challengeId}
else:
  LoginUser → Device/Session: register/upsert device, create session
  LoginUser → ITokenService: issue access JWT + refresh (bound to device)
  LoginUser → IAuditPort + login_history: SUCCESS
  AuthController → Client: 200 {accessToken, refreshToken, user}
```

### 13.3 Password Reset
```
Client → POST /auth/password/forgot {identifier}
ForgotPassword → IUserRepository: find (silent if absent)  → always 200
ForgotPassword → IOtpService: issue reset OTP/link → INotificationPort: send
Client → POST /auth/password/reset {identifier,code,newPassword}
ResetPassword → IOtpService: verify(code)          [400/410 on fail]
ResetPassword → PasswordPolicy: validate            [422 if weak]
ResetPassword → IHasher: hash → IUserRepository: update
ResetPassword → IRefreshTokenRepository: revokeAll(user)  (kill sessions)
ResetPassword → INotificationPort: security alert to all channels
ResetPassword → IAuditPort: PASSWORD_RESET
→ Client: 200 {reset:true}
```

### 13.4 OTP Verification
```
Client → POST /auth/verify-otp {identifier,code,purpose}
VerifyOtp → IOtpService: get(identifier,purpose)   [410 if expired/absent]
VerifyOtp → compare hash; increment attempts       [429 if attempts>max, 400 if wrong]
VerifyOtp → mark consumed; set user.<channel>_verified_at
opt purpose in (LOGIN,REGISTER):
  VerifyOtp → issue tokens (auto-login)
VerifyOtp → IAuditPort: OTP_VERIFIED
→ Client: 200 {verified:true, tokens?}
```

### 13.5 Token Refresh (rotation + reuse detection)
```
Client → POST /auth/token/refresh {refreshToken}
RefreshToken → hash token → IRefreshTokenRepository: findByHash  [401 if none]
alt token.revoked_at or used_at set  (REUSE!):
  RefreshToken → revokeFamily(family_id)
  RefreshToken → IAuditPort: REFRESH_REUSE_DETECTED (alert)
  → Client: 401 AUTH_REFRESH_REUSE_DETECTED
else valid:
  RefreshToken → verify device match + not expired
  RefreshToken → issue new refresh (same family_id), mark old used_at+replaced_by
  RefreshToken → issue new access JWT
  → Client: 200 {accessToken, refreshToken}
```

---

## 14. Error Handling Strategy

**Consistent envelope** for every response.

Success:
```
{ "success": true, "data": { ... }, "meta": { "requestId": "...", "timestamp": "..." } }
```
Error:
```
{ "success": false,
  "error": { "code": "AUTH_INVALID_CREDENTIALS",
             "message": "Invalid phone/email or password.",
             "details": [ ... ]? },
  "meta": { "requestId": "...", "timestamp": "..." } }
```

**Principles**
- **Domain errors** are typed exceptions in the domain/application layers (framework-free), mapped to HTTP by a single `DomainExceptionFilter`. Domain never knows HTTP status codes (separation of concerns).
- **Stable machine-readable `code`** (namespaced `AUTH_*`, `VALIDATION_*`, `RBAC_*`) so clients localize messages themselves (Amharic/English).
- **No sensitive leakage**: login and forgot-password return generic messages to prevent **user enumeration**; internal reasons go to logs/audit only.
- **Validation** via DTOs (class-validator) → `422 VALIDATION_ERROR` with field-level `details`.
- **HTTP mapping**: 400 bad input, 401 unauthenticated, 403 unauthorized (RBAC), 409 conflict, 410 expired, 422 validation, 423 locked, 429 rate-limited, 5xx unexpected (never expose stack traces).
- **Correlation**: every response carries `requestId`; errors are logged with it for traceability.

**Representative error codes**
`AUTH_DUPLICATE_IDENTIFIER, AUTH_INVALID_CREDENTIALS, AUTH_ACCOUNT_SUSPENDED, AUTH_ACCOUNT_LOCKED, AUTH_OTP_INVALID, AUTH_OTP_EXPIRED, AUTH_OTP_ATTEMPTS_EXCEEDED, AUTH_TOKEN_INVALID, AUTH_REFRESH_INVALID, AUTH_REFRESH_REUSE_DETECTED, AUTH_MFA_REQUIRED, AUTH_WEAK_PASSWORD, AUTH_OAUTH_INVALID, RBAC_FORBIDDEN, VERIFICATION_PENDING, VERIFICATION_REJECTED, RATE_LIMITED, VALIDATION_ERROR`.

---

## 15. Logging & Auditing

Two distinct streams:

**A. Operational logs** (observability, NFR-MAINT-04) — structured JSON, centralized, with `requestId`, `userId?`, `route`, `latency`, `status`. **Never** log passwords, OTP codes, tokens, or Fayda numbers.

**B. Audit logs** (compliance, tamper-evident, BRULE-39 / NFR-AUDIT) — append-only, hash-chained `audit_logs`. **Must-log events:**

| Category | Events |
| --- | --- |
| Authentication | login success/failure, logout, logout-all, MFA challenge/verify, account lockout. |
| Registration/Verification | user registered, phone/email verified, Fayda submitted/approved/rejected, license approved/expired-suspension. |
| Tokens | refresh issued, refresh reuse detected, session revoked, device revoked. |
| Account lifecycle | password changed/reset, account suspended/reactivated, deactivated, delete requested. |
| RBAC | role assigned/revoked, permission changed, `perm_version` bumped. |
| Admin/Privileged | every Super Admin/Admin action, break-glass access, config changes. |
| Privacy | consent granted/withdrawn, data-access to sensitive records, data-deletion executed. |

Each audit row records **actor, action, resource, context, IP, timestamp, prev_hash, hash**. Logs are exported to write-once storage and retained per regulatory policy (NFR-PRIV-05, BRULE-41).

---

## 16. Future Scalability

**Horizontal scale (to 5M users, NFR-SCAL-02)**
- **Stateless API tier** — JWT verification needs no DB/session lookup; API nodes scale horizontally behind a load balancer/auto-scaler.
- **Redis for ephemeral state** — OTP, rate-limit counters, permission cache, denylist. Redis cluster with replicas; sharded by key.
- **Postgres scaling** — read replicas for read-heavy paths (profile, sessions list); connection pooling (PgBouncer). Partition high-volume tables (`login_history`, `audit_logs`) by month; archive cold partitions.
- **Permission caching** — effective permission sets cached in Redis keyed by `userId:permVersion`; a version bump invalidates lazily (no mass eviction).

**Evolvability (Open/Closed via ports)**
- **New auth methods** (TOTP authenticator, WebAuthn/passkeys, additional OAuth providers) = new adapters behind existing `ITokenService`/`IOAuthVerifier`/MFA strategy — no domain change.
- **New identity providers** — the `IIdentityVerificationProvider` port lets us add insurance-ID or additional government-ID checks without touching use cases.
- **Extraction to microservice** — because consumers depend on the JWT contract + `IdentityService` interface (not tables), Identity can be lifted into a standalone Auth service with its own DB; publish domain events over a message bus (Outbox pattern) instead of in-process.

**Resilience**
- Multi-AZ deployment, redundant API + Redis + Postgres (NFR-AVAIL-02).
- Graceful degradation: if SMS provider is down, fall back to alternate OTP channel; circuit breakers around Fayda/OAuth adapters.
- PITR backups (RPO ≤ 15m) and documented recovery runbook (RTO ≤ 1h).

**Security evolution**
- Key rotation for JWT signing keys (support multiple active `kid`s).
- Adaptive/risk-based auth later (device reputation, geo-velocity) layered on `login_history` + guard interface.

---

## Open Questions for Product/Compliance (to confirm before build)
1. **Fayda API capabilities** — does the integration expose direct verification, OTP-to-Fayda-phone, or biometric? This determines §9.2 step 2 concretely.
2. **Retention periods** — exact regulatory retention for prescriptions/audit logs (drives partition/archival policy).
3. **Password vs passwordless default** for customers — do we make OTP-passwordless the primary customer path?
4. **MFA scope** — confirm which platform roles require *mandatory* MFA (proposed: all Admin/Finance/Pharmacy Owner+Manager).

