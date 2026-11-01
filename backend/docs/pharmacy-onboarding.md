# Pharmacy organisation onboarding (Works 65 and 67)

How a customer becomes the owner of a pharmacy on PharmaLink through the API, without anyone
writing to the database by hand. Applying is not approval: every approval step stays with an
administrator. Work 65 added the application; Work 67 added the licence approval, organisation
lifecycle and activation gates described from "Licence submission" onwards.

## The sequence

1. **Register and verify an e-mail address.** `POST /auth/register` with `email` and `password`,
   then `POST /auth/verify-otp` with the e-mailed code (`purpose: "REGISTER"`). Work 62.
2. **Sign in.** `POST /auth/login`.
3. **Apply for a pharmacy organisation.** `POST /organizations/pharmacy` (below). PharmaLink creates
   a `PENDING_APPROVAL` organisation of type `PHARMACY`.
4. **Owner membership.** In the same transaction, the caller gets the `PHARMACY_OWNER` role scoped to
   that organisation. Their primary role stays `CUSTOMER`.
5. **Refresh the session.** The membership change bumps the caller's permission version, so the
   access token they applied with is rejected (`401 TOKEN_EXPIRED`). `POST /auth/token/refresh`
   returns one with the owner's permissions, including `pharmacy:register`.
6. **Register the pharmacy.** `POST /pharmacy/register` with `organizationId` and `displayName`
   (Module 04, unchanged). The pharmacy starts in its pending state; registering twice is refused
   (`409`).
7. **Submit the licence documents.** `POST /verification/documents` with
   `type: "PHARMACY_LICENSE"`, the `organizationId` (required) and the documents.
8. **Administrator review.** `POST /admin/verification/:id/approve` with `licenseNumber` and
   `expiresAt`, or `/reject` with a reason (`provider:verify:any`). The Module 16 admin surface
   (`POST /admin/verifications/:id/approve`) takes the same fields. Approval makes the
   **organisation** `ACTIVE`; the pharmacy stays pending.
9. **Activation.** `POST /pharmacy/activate` (`provider:verify:any`), an explicit, separate operator
   action that checks the approved licence before the pharmacy may transact.

Nothing is approved or activated automatically, and approval never activates the pharmacy.

## `POST /organizations/pharmacy`

Authenticated; never public. Requires `pharmacy:apply:own`, which only the `CUSTOMER` role holds.

```http
POST /organizations/pharmacy
Authorization: Bearer <customer access token>

{ "legalName": "Abebe Pharmacy PLC", "idempotencyKey": "6f1c2b0e-0f7a-4a52-9d0e-3c5d2b1a9e47" }
```

| Field | Rules |
|---|---|
| `legalName` | 2–200 characters, not blank. Whitespace is trimmed and collapsed |
| `idempotencyKey` | 8–128 characters (letters, digits, `-`, `_`), e.g. a UUID. Unique per owner |

Those are the only fields. The server decides the owner (always the caller, from the token), the type
(`PHARMACY`), the status (`PENDING_APPROVAL`), the licence fields (empty) and the roles. A request
that includes `ownerUserId`, `organizationId`, `type`, `status`, `roleKey`, `licenseStatus`,
`faydaVerifiedAt`, permissions or any other field is rejected with `400 VALIDATION_ERROR`.

Response (`201`):

```json
{
  "organizationId": "…",
  "type": "PHARMACY",
  "name": "Abebe Pharmacy PLC",
  "status": "PENDING_APPROVAL",
  "membership": { "roleKey": "PHARMACY_OWNER", "organizationId": "…" },
  "createdAt": "…"
}
```

### Who can apply

The account must be `ACTIVE`, have a **verified e-mail address**, and be a customer (primary role
`CUSTOMER`). Otherwise the request is refused with `403 FORBIDDEN` and `details.reason`
(`ACCOUNT_NOT_ACTIVE`, `EMAIL_NOT_VERIFIED` or `NOT_A_CUSTOMER`), and nothing is created. A
phone-verified account without a verified e-mail address can't apply.

### Retries

`(ownerUserId, idempotencyKey)` is unique in the database. Sending the same key again with the same
name returns the same organisation and creates nothing. Sending it with a different name is
`409 IDEMPOTENCY_CONFLICT`. Concurrent duplicates also produce one organisation. One of them may be
answered `401 TOKEN_EXPIRED`, because the winner's membership already invalidated the token; refresh
and repeat.

### Failure behaviour

- If the `PHARMACY_OWNER` role is missing or isn't organisation-scoped (the RBAC seed wasn't
  applied), the request fails (`500`) and nothing is created. It never creates an organisation
  without its owner membership.
- The organisation, the membership and the two audit entries
  (`identity.organization.pharmacy_application_created` and `rbac.user_role.assigned`) are committed
  together or not at all.

## Verification is three different things

| | Proves | Set by |
|---|---|---|
| **E-mail verification** | The person controls that inbox | Registration OTP (`emailVerifiedAt`) |
| **Fayda verification** | Legal identity | The Fayda flow, not yet connected to a real provider (`faydaVerifiedAt`) |
| **Provider approval** | The pharmacy is licensed and may operate | An administrator's licence decision, then explicit activation |

Applying needs only the first. It never sets `faydaVerifiedAt`, and an application never approves
anything.

## Licence submission (Work 67)

`POST /verification/documents` with `type: "PHARMACY_LICENSE"` is organisation-scoped:

- `organizationId` is required (`400 VALIDATION_ERROR` without it).
- It must be the caller's own undeleted organisation. Someone else's, a deleted one or an unknown ID
  all answer `404 NOT_FOUND`, so the endpoint doesn't reveal which organisations exist. The owner is
  always taken from the access token; no owner field is accepted.
- It must be a `PHARMACY`. A pharmacy licence for the caller's own hospital, clinic or laboratory is
  `422 BUSINESS_RULE_VIOLATION` (`details.reason: ORGANIZATION_NOT_PHARMACY`).
- Documents attach to the open (`PENDING`) request for that exact owner and organisation, or open
  one. An owner with two pharmacies has two independent applications. Finding or opening the request,
  attaching and auditing run in one Serializable transaction, and a partial unique index allows only
  one open request per (owner, organisation), so concurrent uploads land on the same request.

`FAYDA`, `DRIVER_DOCS` and `DOCTOR_LICENSE` are unchanged: one open request per user and type, with
an optional `organizationId`.

## Licence approval

`POST /admin/verification/:id/approve` (or `POST /admin/verifications/:id/approve`):

```json
{ "licenseNumber": "EFDA/PH/0042", "expiresAt": "2027-11-01T00:00:00.000Z" }
```

For a `PHARMACY_LICENSE` both fields are required. The licence number is trimmed and must be 1–64
characters (no national format is enforced, because none is specified); the expiry must be a valid
date strictly later than the approval time. Otherwise `400 VALIDATION_ERROR` and nothing changes.

The request must still be `PENDING`, the reviewer must not be the applicant, and it must name an
undeleted `PHARMACY` organisation owned by the applicant. Otherwise `422 BUSINESS_RULE_VIOLATION`
with `details.reason` `ORGANIZATION_MISSING`, `ORGANIZATION_NOT_FOUND`,
`ORGANIZATION_NOT_PHARMACY` or `OWNER_MISMATCH`.

Then, in **one Serializable transaction**:

1. the request moves `PENDING → APPROVED` by compare-and-set (two reviewers at once: one wins, the
   other gets `422`), with `licenseNumber` and `expiresAt` stored on it;
2. the organisation receives the same `licenseNumber` and `licenseExpiresAt` and becomes `ACTIVE`
   (from `PENDING_APPROVAL`, `REJECTED`, `SUSPENDED`, or `ACTIVE` for a renewal);
3. the existing account lift runs (a `PENDING_APPROVAL` provider account becomes `ACTIVE`; an
   `ACTIVE` customer-owner is unchanged);
4. `identity.provider.approved` goes to the outbox;
5. audit entries `identity.verification.approved` and `identity.organization.license_approved`.

Any failure rolls all of it back. Other verification types keep their previous approval behaviour and
need neither field.

## Licence rejection

`POST /admin/verification/:id/reject` with a reason. The same organisation checks apply. In one
Serializable transaction the request moves `PENDING → REJECTED` (compare-and-set), the
`identity.provider.rejected` event and the audit entries are written, and:

- **Initial application:** a `PENDING_APPROVAL` organisation becomes `REJECTED`
  (`identity.organization.application_rejected`). The owner may submit again; a later approval makes
  it `ACTIVE`.
- **Renewal or any other status:** the organisation keeps its status, licence number and expiry. A
  rejected renewal never invalidates a licence that is still valid.

Rejected application data never reaches the organisation.

## Licence expiry

The hourly sweep (`ExpireVerificationsCommand`) treats `expiresAt <= now` as expired. For a
`PHARMACY_LICENSE`, in one Serializable transaction:

- the request moves `APPROVED → EXPIRED` (compare-and-set);
- the organisation moves `ACTIVE → SUSPENDED` **only while its stored licence number and expiry are
  still this request's**. A renewal approved in the meantime replaced them, so an older, superseded
  licence expiring leaves the organisation alone (`identity.license.expired_without_suspension`);
- `identity.license.expired` goes to the outbox, with an audit entry
  (`identity.organization.suspended_license_expired` when it suspended).

The owner's **account is not suspended**: licence eligibility is per organisation, and an owner may
have other organisations with valid licences. Other provider licence types keep their account-level
suspension.

The pharmacy stops being eligible on its own: activation copied the licence expiry onto it, Module
04's eligibility policy treats `licenseExpiresAt <= now` as ineligible, and Module 04's daily
`LicenseExpirySweeper` moves it to `SUSPENDED` / `EXPIRED`.

## Activation

`POST /pharmacy/activate` with `{ "pharmacyId": "…" }` only (`provider:verify:any`; owners can't
activate their own pharmacy). Nothing about the licence is read from the body.

Module 04 reads Identity's own rows through `IIdentityPort` and refuses unless all of these hold:

| Check | Refusal |
|---|---|
| The pharmacy exists and isn't deleted | `404 NOT_FOUND` |
| Its organisation exists and isn't deleted | `404 NOT_FOUND` |
| The organisation is a `PHARMACY` | `403 PHARMACY_NOT_ELIGIBLE`, `ORGANIZATION_NOT_PHARMACY` |
| The organisation is `ACTIVE` | `403 PHARMACY_NOT_ELIGIBLE`, `ORGANIZATION_NOT_ACTIVE` |
| It has a licence number and expiry | `403 PHARMACY_NOT_ELIGIBLE`, `LICENSE_MISSING` |
| The expiry is later than now | `403 LICENSE_EXPIRED` |
| An `APPROVED` `PHARMACY_LICENSE` request exists for this organisation and its owner, with the same licence number and expiry | `403 PHARMACY_NOT_ELIGIBLE`, `LICENSE_NOT_APPROVED` |

A refusal changes nothing and writes no audit entry or event. On success, in one transaction holding
the pharmacy row lock and a share lock on the organisation row, the pharmacy becomes `ACTIVE` with
`licenseStatus = VALID` and the approved expiry, and `PHARMACY_ACTIVATED` (audit) and
`pharmacy.pharmacy.activated` (outbox) are written once. Activating again while it is already active
on the same licence changes nothing and emits nothing. A pharmacy suspended for an expired licence is
restored when a newer licence has been approved and an operator activates it again.

`POST /pharmacy/register` remains a separate step and never activates anything.

## Three statuses

| Status | Belongs to | Means | Changed by |
|---|---|---|---|
| **User status** (`users.status`) | Module 01 | Whether the person can sign in | Registration, admin suspension, provider approval/rejection for provider accounts, expiry of non-pharmacy provider licences |
| **Organization status** (`organizations.status`) | Module 01 | Whether the organisation holds a current approved licence | Licence approval (`ACTIVE`), initial rejection (`REJECTED`), expiry of its current licence (`SUSPENDED`) |
| **Pharmacy transacting status** (`pharmacies.transactingStatus`) | Module 04 | Whether the pharmacy may sell | `POST /pharmacy/activate` (`ACTIVE`), Module 04's expiry sweeper (`SUSPENDED`) |

An `ACTIVE` organisation does not make its pharmacy transact; only activation does.

## Reviewing an application

`GET /admin/verifications/:id` (Module 16, `verification:queue:read`) returns the request, its
`organizationId`, type and status, each document's `kind`, opaque `storageRef` and expiry metadata,
the submission and review times, the rejection reason and the approved `licenseNumber`. It never
returns the Fayda identifier (only `hasFaydaId`), passwords or MFA material.

**No document preview.** `storageRef` is an opaque reference into encrypted object storage. The
storage layer offers no authorized preview or download, so reviewers can't open a document from the
API; none is invented here.

## Known gaps

- **Operations portal is not connected.** `web/src/features/pharmacies/PharmaciesPage.tsx` and
  `pharmacies.service.ts` still use mock data. Approvals, rejections and activation happen only
  through the API until the portal is wired to these endpoints.
- **No document preview** (above).
- **No limit on applications.** A customer may apply for more than one organisation (each needs its
  own key).
- **Staff invitations:** Module 04, Slice 2.
