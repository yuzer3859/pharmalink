# Module 2 — User & Profile Management (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 02 — User & Profile (Customer profiles, Beneficiaries/Family, Addresses, Preferences, Health-record access)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity & Authentication)
**Traceability:** FR-AC-05, FR-AC-07, FR-AC-08, FR-AC-09, FR-AC-12, FR-REC-01..06, BRULE-03, BRULE-04, BRULE-21, NFR-PRIV-01..06, NFR-SEC-10, NFR-AUDIT-01..03, NFR-USE-02, NFR-LOC-01..03

> Single source of truth for the User & Profile bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

Module 1 answered *who is this actor and what can they do*. Module 2 answers *who is this person as a healthcare consumer* — their profile, the **family members (beneficiaries)** they order for, their **delivery addresses**, their **preferences**, and the **access-control rules that protect health data**.

**Boundary rule.** Module 1 owns the `users` aggregate (credentials, roles, status, verification flags). Module 2 owns the **customer-facing profile domain** that hangs off a user: `customer_profiles`, `beneficiaries`, `addresses`, `preferences`, `guardianships`, and the **beneficiary/health-record access policy**. Module 2 references a user by `userId` only — it never touches auth tables directly (bounded-context integrity).

**Primary objectives**
- Provide a complete, editable **customer profile** (contact, demographics, language) — FR-AC-05, FR-AC-09.
- Enable **family healthcare management**: add/manage beneficiaries and order/book on their behalf — FR-AC-07, a core differentiator of the platform (diaspora ordering, BRULE-21).
- Manage **multiple saved delivery addresses with GPS** — FR-AC-08, NFR-LOC-03.
- Enforce **guardianship for minors** — BRULE-03.
- Enforce **strict access control + audit on health records and beneficiary data** — BRULE-04, FR-REC-04/06, NFR-SEC-10.
- Support **account deactivation & data-deletion** at the profile level, coordinated with Identity — FR-AC-12, NFR-PRIV-04.

**Design rationale — why a separate module from Identity.** Profiles, beneficiaries, and addresses change far more often and have different sensitivity/retention rules than credentials. Separating them keeps the Identity aggregate small and secure, lets the profile schema evolve independently, and cleanly isolates **health-data privacy concerns** (NFR-PRIV) in one place. It also enables reuse: Order, Delivery, and Appointment modules consume `beneficiaryId` + `addressId` through a stable interface without knowing internal structure.

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-USR-01 | A user can create and edit a profile with contact and delivery details. | FR-AC-05 |
| BR-USR-02 | A customer can add and manage beneficiaries (family members). | FR-AC-07 |
| BR-USR-03 | Beneficiaries can be selected as the recipient for an order/appointment/test. | FR-AC-07, FR-ORD-03 |
| BR-USR-04 | A user can save and manage multiple delivery addresses with GPS coordinates. | FR-AC-08 |
| BR-USR-05 | A user can set a preferred language (Amharic/English) and notification preferences. | FR-AC-09, FR-NOT-05 |
| BR-USR-06 | A minor's account/profile must be managed by a verified adult guardian. | BRULE-03 |
| BR-USR-07 | Access to a beneficiary's records is restricted to the owner, the beneficiary (if an adult account), and authorized providers with a valid transactional relationship. | BRULE-04, FR-REC-04 |
| BR-USR-08 | Diaspora orders must specify a valid beneficiary and a delivery address within Ethiopia. | BRULE-21 |
| BR-USR-09 | A customer can view and manage records (orders/prescriptions/appointments) for their beneficiaries. | FR-REC-05 |
| BR-USR-10 | A user can request account deactivation and data deletion per policy. | FR-AC-12, NFR-PRIV-04 |
| BR-USR-11 | All access to sensitive profile/health data must be logged. | FR-REC-06, NFR-AUDIT-01 |
| BR-USR-12 | The platform collects only necessary personal/medical data and records consent. | NFR-PRIV-02, NFR-PRIV-03 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Customer Profile
- **F-PRF-01** View own profile (identity contact + demographics + preferences).
- **F-PRF-02** Edit profile: full name, gender, date of birth, profile photo, secondary contact.
- **F-PRF-03** Set/update preferred language (Amharic/English) — drives localized UI & notifications.
- **F-PRF-04** Manage notification preferences (push/SMS/email per event category) — coordinates with Notification module.
- **F-PRF-05** Upload/replace/remove profile photo (stored in Cloud Storage, ref only in DB).

### 3.2 Beneficiaries (Family Healthcare)
- **F-BEN-01** Add a beneficiary: relationship, name, gender, DOB, optional phone, optional allergies/notes.
- **F-BEN-02** Edit / archive / remove a beneficiary (soft-delete; historical orders retain the snapshot).
- **F-BEN-03** List beneficiaries; mark a default beneficiary ("myself" is an implicit self-beneficiary).
- **F-BEN-04** Select a beneficiary as recipient at checkout / appointment / test booking.
- **F-BEN-05** Minor beneficiary handling — no independent login; fully managed by owner (BRULE-03).
- **F-BEN-06** Optional link/claim: a beneficiary who is an adult can be invited to claim their own account, converting a managed record into a linked adult account (consent-based).
- **F-BEN-07** Beneficiary health context: allergies, chronic conditions, blood type (optional, encrypted) — surfaced to pharmacist during Rx verification with consent.

### 3.3 Addresses
- **F-ADR-01** Add address: label (Home/Work/Other), recipient name+phone, region/city/subcity/woreda, landmark, free-text, GPS lat/lng.
- **F-ADR-02** Edit / delete address; set a default delivery address.
- **F-ADR-03** Validate address is within Ethiopia for delivery (BRULE-21) — geofence check.
- **F-ADR-04** Reverse-geocode pin to structured fields (via Mapping adapter port).
- **F-ADR-05** Associate an address with a beneficiary (deliver to the family member's location).

### 3.4 Preferences & Consent
- **F-PRE-01** Language, currency display (ETB default; diaspora may see dual display), timezone.
- **F-PRE-02** Notification channel preferences per category.
- **F-PRE-03** Consent management: view, grant, and withdraw consents (data processing, health-data sharing with pharmacist) — NFR-PRIV-03.

### 3.5 Health Record Access (read model / policy)
- **F-REC-01** Aggregated timeline: orders, prescriptions, appointments, tests — per user and per beneficiary (FR-REC-02).
- **F-REC-02** Download/export own & beneficiary records (FR-REC-03).
- **F-REC-03** Enforce access-control policy on every read (FR-REC-04) and **log every access** (FR-REC-06).

> **Note:** Module 2 owns the **access-control policy and beneficiary/profile data**; the actual prescription/order/appointment records live in their own modules. Module 2 exposes a `BeneficiaryAccessPolicy` used by those modules to authorize record access.

### 3.6 Lifecycle
- **F-LFC-01** Deactivate account (reversible) — coordinates with Identity status.
- **F-LFC-02** Request data deletion (NFR-PRIV-04) — soft-delete + scheduled purge respecting regulatory retention (BRULE-41).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Privacy** | Data minimization, consent, PII/health segregation, deletion (NFR-PRIV-01..06) | Optional health fields; consent records; health fields encrypted & logically separated; soft-delete + purge job. |
| **Security** | Health records access-controlled + audited (NFR-SEC-10, FR-REC-06) | `BeneficiaryAccessPolicy` guard on every record read; field-level encryption (allergies, conditions, DOB of minors). |
| **Auditability** | Actor/time/context on sensitive reads/writes (NFR-AUDIT) | Reuse Module 1 hash-chained `audit_logs`; add `HEALTH_RECORD_ACCESSED` events. |
| **Localization** | Amharic/English, ETB, Ethiopian addresses (NFR-USE-02, NFR-LOC) | `preferredLanguage`; structured Ethiopian address model (region/city/subcity/woreda); geofence to ET. |
| **Performance** | Fast profile/address reads (NFR-PERF) | Denormalized read models; cache default address & beneficiary list per user in Redis. |
| **Usability** | Low steps, mobile-first (NFR-USE-04/05) | "Self" is implicit default beneficiary; default address auto-selected at checkout. |
| **Scalability** | Grows to 5M users (NFR-SCAL-02) | 1:N children (beneficiaries/addresses) partition naturally by `userId`; stateless services. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **CustomerProfile** (aggregate root, 1:1 with `users.id`) — demographic + preference data for a customer.
- **Beneficiary** (entity within the customer's family aggregate) — a person the customer manages/orders for.
- **Address** (entity) — a saved delivery location, optionally tied to a beneficiary.
- **Guardianship** (relationship) — links a guardian user to a minor beneficiary/managed account (BRULE-03).
- **Consent** (shared with Module 1's `consents`) — extended with health-data-sharing consent types.
- **NotificationPreference** (value collection) — channel prefs per category.

### 5.2 Value Objects
- `PersonName`, `DateOfBirth` (derives `isMinor` via legal age), `Gender`, `Relationship` (SELF|SPOUSE|CHILD|PARENT|SIBLING|OTHER), `EthiopianAddress` (region/city/subcity/woreda/landmark), `GeoPoint` (lat/lng validated within ET bounds), `LanguageCode` (am|en), `HealthNote` (encrypted).

### 5.3 Key domain rules (invariants)
- A `CustomerProfile` always has an implicit **SELF beneficiary** (the account owner) — simplifies "order for myself."
- A `Beneficiary` with `DateOfBirth.isMinor == true` **must** have a `Guardianship` to a verified adult (BRULE-03). Minor beneficiaries cannot be promoted to an independent login without guardian action.
- An `Address` used for delivery **must** pass the ET geofence (BRULE-21).
- Removing a beneficiary/address is a **soft-delete**; existing orders keep an immutable **snapshot** of the recipient/address at time of order (never mutate historical records).

**Design rationale — snapshots vs references.** Operational modules (Order/Delivery) store a **snapshot** of the beneficiary + address at order time, and only a soft `beneficiaryId`/`addressId` reference for navigation. This preserves historical accuracy (BRULE compliance, disputes) even after the customer edits or deletes the beneficiary/address later.

---

## 6. Access Control — BeneficiaryAccessPolicy (BRULE-04, FR-REC-04)

A dedicated **domain service** other modules call to authorize access to a beneficiary's data/records.

**Access is granted if any holds:**
1. **Owner** — requesting user owns the customer profile that the beneficiary belongs to.
2. **Self (adult linked account)** — the beneficiary is a linked adult account and the requester *is* that user.
3. **Guardian** — requester is the verified guardian of a minor beneficiary.
4. **Authorized provider** — a verified provider (pharmacist/doctor/lab) with a **valid transactional relationship** (an active order/appointment/test) *and* a valid consent record, limited to the relevant record scope and time window.

**Every allow/deny decision emits an audit event** (`HEALTH_RECORD_ACCESS_CHECK`) with actor, subject beneficiary, resource, and outcome (FR-REC-06). Deny returns `RBAC_FORBIDDEN` without leaking existence details.

**Reasoning.** Centralizing this in one policy service (Single Responsibility) means Prescription, Order, and Appointment modules cannot accidentally implement inconsistent rules. It is the enforcement point for the platform's most sensitive privacy requirement.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs, `created_at`/`updated_at`, soft-delete (`deleted_at`) where lifecycle applies. Health-sensitive columns encrypted at rest (field-level).

**customer_profiles** — 1:1 with `users`.
- `id`, `user_id` (unique FK → users.id), `full_name`, `gender`, `date_of_birth`, `photo_url`, `preferred_language` (am|en), `secondary_phone`, `timezone`, `created_at`, `updated_at`, `deleted_at`.
- *Purpose:* customer demographic + preference root.

**beneficiaries** — family members managed by a customer.
- `id`, `owner_user_id` (FK → users.id), `relationship` (enum), `full_name`, `gender`, `date_of_birth`, `phone` (nullable), `is_self` (bool), `linked_user_id` (FK → users.id, nullable — if claimed as adult account), `is_minor` (derived/stored), `health_notes_encrypted` (nullable), `allergies_encrypted` (nullable), `blood_type` (nullable), `status` (ACTIVE|ARCHIVED), `created_at`, `updated_at`, `deleted_at`.
- Unique: one `is_self=true` per `owner_user_id`.
- *Purpose:* BR-USR-02/03; family healthcare.

**guardianships** — guardian ↔ minor link (BRULE-03).
- `id`, `guardian_user_id` (FK → users.id), `beneficiary_id` (FK → beneficiaries.id), `verified` (bool), `created_at`, `revoked_at`.
- *Purpose:* enforce minor management.

**addresses** — saved delivery locations.
- `id`, `user_id` (FK → users.id), `beneficiary_id` (FK → beneficiaries.id, nullable), `label` (HOME|WORK|OTHER), `recipient_name`, `recipient_phone`, `region`, `city`, `subcity`, `woreda`, `landmark`, `address_line`, `lat`, `lng`, `is_default` (bool), `is_within_ethiopia` (bool), `created_at`, `updated_at`, `deleted_at`.
- Constraint: at most one `is_default=true` per `user_id`.
- *Purpose:* BR-USR-04, BRULE-21.

**notification_preferences** — per-user channel prefs.
- `id`, `user_id` (FK), `category` (ORDER|PRESCRIPTION|APPOINTMENT|DELIVERY|MARKETING|SECURITY), `push` (bool), `sms` (bool), `email` (bool), `updated_at`.
- Unique (`user_id`,`category`).

**consents** — extends Module 1's consents (shared table) with health types.
- `type` values include: `DATA_PROCESSING`, `HEALTH_DATA_SHARING`, `MARKETING`, `BENEFICIARY_DATA_MGMT`.

**Relationships (summary)**
- `users 1—1 customer_profiles`.
- `users 1—N beneficiaries` (as owner); `beneficiaries 0..1—1 users` via `linked_user_id`.
- `users 1—N addresses`; `addresses 0..1—1 beneficiaries`.
- `guardianships` join `users` (guardian) ↔ `beneficiaries` (minor).
- `users 1—N notification_preferences`, `1—N consents`.

**Rationale.** Beneficiaries reference `owner_user_id` (not `customer_profiles.id`) so the model works even before a full profile is filled, and aligns with how operational modules pass `userId`. Health-sensitive fields are isolated into clearly named encrypted columns to satisfy NFR-PRIV-06 segregation and simplify audits.

---

## 8. API Design

Base paths: `/api/v1/profile`, `/api/v1/beneficiaries`, `/api/v1/addresses`, `/api/v1/preferences`, `/api/v1/records`. All require Bearer auth. Standard response envelope + error codes from Module 1 §14.

### 8.1 Profile
- **GET `/profile/me`** — `profile:read:own`. → profile + preferences + default address/beneficiary.
- **PATCH `/profile/me`** — `profile:update:own`. Body: `{ fullName?, gender?, dateOfBirth?, preferredLanguage?, secondaryPhone?, timezone? }`.
- **POST `/profile/me/photo`** — multipart upload → `{ photoUrl }`. **DELETE** removes it.

### 8.2 Beneficiaries
- **GET `/beneficiaries`** — `beneficiary:manage:own`. List (incl. implicit SELF).
- **POST `/beneficiaries`** — Body: `{ relationship, fullName, gender, dateOfBirth, phone?, allergies?, healthNotes?, bloodType? }`. → 201. If minor, guardianship auto-created to requester.
- **GET `/beneficiaries/{id}`** — access via `BeneficiaryAccessPolicy`. Audited.
- **PATCH `/beneficiaries/{id}`** — update. **DELETE `/beneficiaries/{id}`** — soft-delete/archive.
- **POST `/beneficiaries/{id}/invite-claim`** — invite an adult beneficiary to claim own account (consent flow). → 202.
- Errors: 403 `RBAC_FORBIDDEN`, 409 `BENEFICIARY_SELF_EXISTS`, 422 `VALIDATION_ERROR`, 422 `MINOR_REQUIRES_GUARDIAN`.

### 8.3 Addresses
- **GET `/addresses`** — list. **POST `/addresses`** — create (geofence-validated).
- **PATCH `/addresses/{id}`** / **DELETE `/addresses/{id}`**.
- **POST `/addresses/{id}/default`** — set default.
- **POST `/addresses/geocode`** — Body `{ lat, lng }` → reverse-geocoded structured fields.
- Errors: 422 `ADDRESS_OUTSIDE_ETHIOPIA` (BRULE-21), 422 `VALIDATION_ERROR`.

### 8.4 Preferences & Consent
- **GET/PUT `/preferences/notifications`** — channel prefs per category.
- **GET/PUT `/preferences/general`** — language, currency display, timezone.
- **GET `/preferences/consents`** / **POST `/preferences/consents`** — grant/withdraw `{ type, granted }`. Audited.

### 8.5 Records (read model + access-controlled)
- **GET `/records/timeline?beneficiaryId=`** — aggregated orders/prescriptions/appointments/tests. Access via policy; **every read audited**. → paginated timeline.
- **GET `/records/export?beneficiaryId=`** — export (PDF/JSON) of records the requester may access. Audited.

### 8.6 Lifecycle
- **POST `/profile/me/deactivate`** — coordinates with Identity (status → DEACTIVATED). Bearer + step-up.
- **POST `/profile/me/delete-request`** — schedules purge per retention policy. Bearer + step-up. Audited.

---

## 9. NestJS Folder Structure (Clean Architecture)

Mirrors Module 1's layering; lives as a sibling bounded context.

```
src/modules/user-profile/
  domain/
    entities/            # CustomerProfile, Beneficiary, Address, Guardianship
    value-objects/       # PersonName, DateOfBirth, EthiopianAddress, GeoPoint, Relationship, LanguageCode, HealthNote
    events/              # ProfileUpdated, BeneficiaryAdded, BeneficiaryArchived, AddressAdded, ConsentChanged, HealthRecordAccessed
    enums/               # Relationship, AddressLabel, BeneficiaryStatus, ConsentType, NotificationCategory
    repositories/        # IProfileRepository, IBeneficiaryRepository, IAddressRepository, IGuardianshipRepository, IPreferenceRepository
    services/            # BeneficiaryAccessPolicy, MinorGuardianRule
  application/
    commands/            # UpdateProfile, AddBeneficiary, ArchiveBeneficiary, AddAddress, SetDefaultAddress, SetConsent, RequestDataDeletion, InviteBeneficiaryClaim
    queries/             # GetProfile, ListBeneficiaries, ListAddresses, GetRecordsTimeline, ExportRecords
    ports/               # IGeocodingPort (mapping), IStoragePort (photos), ICachePort, IAuditPort, IIdentityPort (read user status), INotificationPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/   # Prisma*Repository implementations
    geocoding/           # MappingProviderAdapter (+ MockGeocoder)
    storage/             # CloudStoragePhotoAdapter
    cache/               # RedisCacheAdapter
    audit/               # reuse shared HashChainAuditAdapter
    identity/            # IdentityPortAdapter (calls Module 1 interface, not tables)
  interface/
    http/
      controllers/       # ProfileController, BeneficiaryController, AddressController, PreferenceController, RecordsController
      dtos/  guards/      # PermissionsGuard (reused), BeneficiaryAccessGuard
      decorators/ filters/ interceptors/  # AuditInterceptor on record reads
    events/              # handlers: on BeneficiaryAdded → invalidate cache; on ConsentChanged → notify
  user-profile.module.ts
```

**Cross-module contract.** Module 2 talks to Module 1 only through an `IIdentityPort` (e.g., `getUserStatus`, `isProviderVerified`) — never by importing Identity repositories. This preserves bounded-context isolation and keeps future service extraction clean.

---

## 10. Sequence Flows

### 10.1 Add Beneficiary (with minor check)
```
Client → BeneficiaryController: POST /beneficiaries {relationship,name,dob,...}
AddBeneficiary → validate DTO
AddBeneficiary → DateOfBirth.isMinor?
  yes → create Guardianship(guardian=currentUser, verified=guardian is Fayda-verified)
       → if guardian not verified: still allow create but flag MINOR_GUARDIAN_UNVERIFIED (config)
AddBeneficiary → IBeneficiaryRepository: save (encrypt health fields)
AddBeneficiary → emit BeneficiaryAdded
BeneficiaryAdded handler → ICachePort: invalidate beneficiary list
AddBeneficiary → IAuditPort: BENEFICIARY_ADDED
→ Client: 201 {beneficiaryId}
```

### 10.2 Add Address (geofence)
```
Client → AddressController: POST /addresses {..., lat, lng}
AddAddress → IGeocodingPort: reverseGeocode(lat,lng) → structured fields (fill gaps)
AddAddress → GeoPoint.withinEthiopia(lat,lng)?  [422 ADDRESS_OUTSIDE_ETHIOPIA if no]
AddAddress → IAddressRepository: save; if first address → is_default=true
AddAddress → IAuditPort: ADDRESS_ADDED
→ Client: 201 {addressId}
```

### 10.3 Access Beneficiary Records (policy + audit)
```
Client → RecordsController: GET /records/timeline?beneficiaryId=B
GetRecordsTimeline → BeneficiaryAccessPolicy.canAccess(currentUser, B, scope)
  → check owner | linked-self | guardian | authorized-provider(+consent)
GetRecordsTimeline → IAuditPort: HEALTH_RECORD_ACCESS_CHECK {actor,B,outcome}
alt denied → 403 RBAC_FORBIDDEN
else → aggregate from Order/Prescription/Appointment read-models (via ports)
     → IAuditPort: HEALTH_RECORD_ACCESSED
     → Client: 200 {timeline}
```

### 10.4 Data-Deletion Request
```
Client → POST /profile/me/delete-request  (Bearer + step-up)
RequestDataDeletion → IIdentityPort: markDeletionRequested(userId)
RequestDataDeletion → schedule purge job respecting retention (BRULE-41)
RequestDataDeletion → soft-delete profile/beneficiaries/addresses (retain audited health records per policy)
RequestDataDeletion → IAuditPort: DATA_DELETION_REQUESTED
→ Client: 202 {status:"SCHEDULED", effectiveAfter}
```

---

## 11. Error Handling

Reuses Module 1 §14 envelope, filter, and correlation strategy. Module-specific codes:

`PROFILE_NOT_FOUND, BENEFICIARY_SELF_EXISTS, BENEFICIARY_NOT_FOUND, MINOR_REQUIRES_GUARDIAN, MINOR_GUARDIAN_UNVERIFIED, ADDRESS_OUTSIDE_ETHIOPIA, ADDRESS_NOT_FOUND, DEFAULT_ADDRESS_REQUIRED, CONSENT_REQUIRED, RBAC_FORBIDDEN, VALIDATION_ERROR`.

Access denials on records return **generic 403** (no existence leak). Health-field validation errors never echo the sensitive value back.

---

## 12. Logging & Auditing

Reuses the hash-chained `audit_logs` from Module 1. **Must-log events:**

| Category | Events |
| --- | --- |
| Profile | profile updated, photo changed, language/preference changed. |
| Beneficiary | added, edited, archived, deleted, claim invited/accepted, guardianship created/revoked. |
| Address | added, edited, deleted, default changed, geofence rejection. |
| Consent | granted, withdrawn (esp. HEALTH_DATA_SHARING). |
| **Health records** | every access check (allow/deny), every record read, every export (FR-REC-06). |
| Lifecycle | deactivation, data-deletion requested/executed. |

Operational logs never contain health-note contents, DOB of minors, or full addresses beyond what's needed for debugging (PII minimization).

---

## 13. Future Scalability & Evolution

- **Read-model aggregation** for `/records/timeline` should be assembled via **module ports** (Order/Prescription/Appointment expose query interfaces). At scale, replace with a **materialized read model / CQRS projection** fed by domain events — same controller contract.
- **Geocoding** behind `IGeocodingPort` → swap mapping providers freely; cache reverse-geocode results.
- **Beneficiary claim flow** enables organic growth: managed adults become full users without data migration.
- **Consent versioning** supports evolving privacy law (NFR-PRIV-01) — re-consent prompts on version bump.
- **Partitioning** — `beneficiaries`/`addresses` partition naturally by `owner_user_id`; caches keyed per user.
- **Extraction-ready** — because Module 2 depends on Identity only via `IIdentityPort` and on other modules via query ports, it can be extracted into a Profile service with its own DB and event-driven read models.

---

## Open Questions for Product/Compliance
1. **Legal age of majority** in Ethiopia for the `isMinor` threshold (affects BRULE-03 enforcement).
2. **Provider access window** — for how long after a completed transaction may a pharmacist/doctor view beneficiary health context? (defines policy #4 time bound).
3. **Retention on deletion** — which records survive a data-deletion request due to regulatory retention (BRULE-41), and for how long?
4. **Health context capture** — do we collect allergies/conditions at MVP, or defer to a later Health Records module? (impacts encrypted fields now.)

---

**End of Module 2 design.** Awaiting your approval to proceed. Recommended next module: **Catalog** (medicines & healthcare products, Rx/OTC classification, drug metadata) — the entry point of the pharmacy marketplace and a dependency for Pharmacy Inventory and Cart/Order.
