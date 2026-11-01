# Pharmacy organisation onboarding (Work 65)

How a customer becomes the owner of a pharmacy on PharmaLink through the API, without anyone
writing to the database by hand. Applying is not approval: every approval step stays with an
administrator.

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
   `type: "PHARMACY_LICENSE"`, the `organizationId` and the documents (existing workflow).
8. **Administrator review.** `POST /admin/verification/:id/approve` or `/reject`
   (`provider:verify:any`).
9. **Activation.** `POST /pharmacy/activate` (`provider:verify:any`), an explicit, separate operation.

Nothing is approved or activated automatically.

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

## Known gaps (not changed in this work)

- **Licence approval doesn't update the organisation.** Approving a `PHARMACY_LICENSE` verification
  doesn't change the organisation's `status`, `licenseNumber` or `licenseExpiresAt`. Organisations
  created here therefore stay `PENDING_APPROVAL`.
- **Activation has no gate.** `POST /pharmacy/activate` checks neither the organisation status nor an
  approved licence verification. It relies on the administrator invoking it only after approval, and
  snapshots whatever `licenseExpiresAt` the organisation holds (null here).
- **No limit on applications.** A customer may apply for more than one organisation (each needs its
  own key).
- **Staff invitations:** Module 04, Slice 2.
