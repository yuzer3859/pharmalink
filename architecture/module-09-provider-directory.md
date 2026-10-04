# Module 9 — Provider Directory (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 09 — Provider Directory (Hospitals, Clinics, Diagnostic Centers, Laboratories)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity/org verification), 02 (geolocation/address conventions). Consumed by: Doctor & Appointment (10), Diagnostics (11), Search & Matching, Reviews.
**Traceability:** FR-HOSP-01..08, FR-LAB-01..04, FR-PRV-01..04/07/09/10, FR-ADM-11, BRULE-06, BRULE-07, BRULE-08, NFR-LOC-03, NFR-COMP-01, NFR-AUDIT

> Single source of truth for the Provider Directory bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module is the **healthcare-provider registry** — the Phase 2 foundation. It maintains verified profiles for **hospitals, clinics, diagnostic centers, and laboratories**, their locations, departments/specialties, facilities, operating hours, and service offerings. It is the structural backbone that **Doctor & Appointment (Module 10)** and **Diagnostics (Module 11)** build upon.

**Boundary & reuse.** A provider institution is a Module 1 **organization** (like a pharmacy) with type `HOSPITAL|CLINIC|DIAGNOSTIC_CENTER|LAB`, verified via the same Module 1 verification workflow (BRULE-07). This module owns the **directory/profile domain** (institution details, departments, facilities, geolocation, service listings) — not appointments (Module 10) or test bookings (Module 11), which reference these profiles.

**Design decision — one flexible provider model vs separate hospital/lab models.** Hospitals, clinics, diagnostic centers, and labs share ~80% of structure (profile, location, hours, verification, ratings, services) and differ mainly in *what services they expose* (departments/doctors vs tests/imaging). I use a **single `HealthcareProvider` aggregate with a `type` discriminator** + type-specific service extensions, rather than four parallel models. This avoids duplication, enables **unified "nearby providers" search** (FR-HOSP-05, FR-LAB-04), and keeps the directory consistent — while polymorphic service listings capture the differences.

**Primary objectives**
- Register & verify healthcare institutions before they publish services (FR-PRV-01..04, BRULE-07, NFR-COMP-01).
- Maintain rich **institution profiles**: name, logo/photos, address, GPS, contact, hours, facilities, emergency availability (FR-HOSP-01..04).
- Model **departments/specialties** (hospitals/clinics) and **service catalogs** (labs/diagnostics) (FR-HOSP-03, FR-LAB-02).
- Support **location-first, nearest-first search** with search by city/specialty/name (FR-HOSP-05/06, FR-LAB-04, NFR-LOC-03).
- Enable **bidirectional navigation** hospital ↔ doctors (FR-HOSP-08) — coordinated with Module 10.
- **Auto-suspend** providers with expired licenses (BRULE-08, FR-PRV-09).
- Support admin verification queues and profile moderation (FR-PRV-03, FR-ADM-11).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-DIR-01 | Hospitals/clinics/diagnostic centers/labs shall register and be verified before publishing services. | FR-PRV-01..04, BRULE-07 |
| BR-DIR-02 | Only verified institutions may publish services. | BRULE-07, NFR-COMP-01 |
| BR-DIR-03 | Each institution shall have a profile with address, GPS, contact, and operating hours. | FR-HOSP-01/02 |
| BR-DIR-04 | Hospitals shall list departments, specialties, and affiliated doctors. | FR-HOSP-03 |
| BR-DIR-05 | Institutions shall indicate emergency service availability. | FR-HOSP-04 |
| BR-DIR-06 | The directory shall list nearest institutions first and allow search by city/specialty/name. | FR-HOSP-05/06, FR-LAB-04 |
| BR-DIR-07 | The directory shall support diagnostic centers/labs and their service/test catalogs. | FR-LAB-01/02 |
| BR-DIR-08 | Estimated pricing shall be displayable where available. | FR-LAB-03 |
| BR-DIR-09 | Users shall navigate from a hospital to its doctors and vice versa. | FR-HOSP-08 |
| BR-DIR-10 | Providers with expired licenses shall be suspended. | BRULE-08, FR-PRV-09 |
| BR-DIR-11 | Providers shall set operating hours and service zones. | FR-PRV-10 |
| BR-DIR-12 | Institution profiles shall support ratings/reviews display. | FR-HOSP-07 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Institution Onboarding & Profile
- **F-DIR-01** Register institution (type: HOSPITAL/CLINIC/DIAGNOSTIC_CENTER/LAB); org created PENDING_APPROVAL.
- **F-DIR-02** Upload license/accreditation → Module 1 verification (BRULE-07).
- **F-DIR-03** Activate on approval; block service publishing otherwise.
- **F-DIR-04** Manage profile: name, logo, photos, description, contact, website.
- **F-DIR-05** Address + GPS (Ethiopian conventions, NFR-LOC-03); multiple branches/locations.
- **F-DIR-06** Operating hours per location; **emergency services** flag + 24/7 indicator (FR-HOSP-04).
- **F-DIR-07** Facilities/amenities list (parking, pharmacy on-site, ambulance, wheelchair access).

### 3.2 Departments & Specialties (hospitals/clinics)
- **F-DEP-01** Manage departments (e.g., Cardiology, Pediatrics) and specialties offered.
- **F-DEP-02** Associate doctors with departments (link maintained with Module 10).
- **F-DEP-03** Department-level contact/hours where applicable.

### 3.3 Service Catalog (diagnostic centers/labs)
- **F-SVC-01** Manage service catalog: lab tests, imaging (X-ray, Ultrasound, CT, MRI), screening packages (FR-LAB-02).
- **F-SVC-02** Estimated pricing per service where available (FR-LAB-03).
- **F-SVC-03** Preparation instructions per test (surfaced at booking, Module 11).
- **F-SVC-04** Service availability flags (offered/temporarily unavailable).

### 3.4 Discovery & Search
- **F-SRCH-01** Nearest-first listing based on user location (FR-HOSP-05, NFR-LOC-03).
- **F-SRCH-02** Search/filter by city, specialty, service/test, name, emergency availability (FR-HOSP-06, FR-LAB-04).
- **F-SRCH-03** Provider detail view: profile + departments/services + doctors (link) + ratings.
- **F-SRCH-04** Bidirectional navigation: hospital → its doctors; doctor → hospitals they practice at (FR-HOSP-08, with Module 10).
- **F-SRCH-05** Compare nearby diagnostic centers (services/price/distance) (FR-LAB-04).

### 3.5 Lifecycle & Moderation
- **F-LFC-01** License-expiry auto-suspension (BRULE-08).
- **F-LFC-02** Admin verification queue + profile moderation (FR-PRV-03, FR-ADM-11).
- **F-LFC-03** Provider self-service profile updates (re-moderated if sensitive fields change).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Discoverability/Perf** | Nearest-first, fast search (FR-HOSP-05, NFR-PERF-01) | Geospatial index (PostGIS/geohash); denormalized `provider_search_view`; Redis cache. |
| **Localization** | Ethiopian address/geo (NFR-LOC-03) | Structured region/city/subcity/woreda + GPS; Amharic/English profile fields. |
| **Compliance** | Verified-only publishing, license expiry (BRULE-07/08, NFR-COMP-01) | `ProviderEligibilityPolicy` (reuses Module 1 verification); expiry sweeper. |
| **Consistency** | Unified provider model across types | Single aggregate + type discriminator + polymorphic service listings. |
| **Scalability** | Nationwide directory (NFR-SCAL) | Read-dominant, cacheable; CDN for images; read replicas. |
| **Auditability** | Profile/verification changes traced (NFR-AUDIT) | Hash-chained audit on verification, suspension, sensitive edits. |
| **Extensibility** | Future insurance/facility integrations (NFR-INTEROP-03) | Service/facility modeled as data; provider capabilities extensible. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **HealthcareProvider** (aggregate root) — the institution (hospital/clinic/diagnostic/lab), maps to a Module 1 organization.
- **ProviderLocation** (entity) — a physical branch: address, GPS, hours, emergency flag, facilities.
- **Department** (entity) — hospital/clinic organizational unit + specialties (links to doctors via Module 10).
- **ServiceOffering** (entity, polymorphic) — a published service: `LAB_TEST | IMAGING | SCREENING_PACKAGE` (labs/diagnostics) with pricing + prep.
- **Facility** (value) — amenity/capability tag.
- **ProviderReviewSummary** (projection) — aggregated ratings from Module 13.

### 5.2 Value Objects
- `ProviderType` (HOSPITAL|CLINIC|DIAGNOSTIC_CENTER|LAB), `EthiopianAddress`, `GeoPoint`, `OperatingHours`, `EmergencyAvailability` (NONE|BUSINESS_HOURS|24_7), `Specialty`, `ServiceType`, `Money` (ETB), `PreparationInstructions`, `VerificationState` (mirrors Module 1).

### 5.3 Invariants
- A provider may **publish services/departments only if verified & eligible** (Module 1 approved, license valid — BRULE-07, NFR-COMP-01).
- `ServiceOffering` (tests/imaging/packages) exist only for `DIAGNOSTIC_CENTER|LAB`; `Department`/specialties primarily for `HOSPITAL|CLINIC`. (Model allows overlap where real-world providers do both.)
- License expiry → provider `SUSPENDED`, services hidden from discovery (BRULE-08).
- Every provider location carries GPS for nearest-first search (FR-HOSP-05) — required for publishing.
- Sensitive profile changes (name, license, ownership) re-enter moderation (FR-ADM-11).

**Design rationale — polymorphic `ServiceOffering`.** Lab tests, imaging, and screening packages differ but share the booking-relevant shape (name, price, prep, duration, availability). A single `ServiceOffering` with a `type` discriminator + type-specific attributes (jsonb) keeps Module 11 (Diagnostics booking) simple — it books a `ServiceOffering` regardless of subtype — while remaining extensible for new service types.

---

## 6. Provider Eligibility (BRULE-07/08)

`ProviderEligibilityPolicy` (domain service) — the single gate for "may this institution publish/appear?", analogous to Module 4's pharmacy eligibility:

**Eligible iff:** org `ACTIVE` + verification `APPROVED` + license `VALID` (not expired) + not manually `SUSPENDED`.

- Consulted by service/department publishing, and by discovery/search (ineligible providers excluded).
- A **license-expiry sweeper** (shared pattern with Module 4) auto-suspends expired providers, hides their services, emits `ProviderSuspended`, and notifies. Renewal via Module 1 re-verification restores eligibility.

**Design rationale.** Reusing the same eligibility/verification/expiry pattern across pharmacies (Module 4) and healthcare institutions (this module) keeps compliance enforcement uniform and lets us share the verification workflow, sweeper, and audit conventions — less code, consistent behavior.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; soft-delete where lifecycle applies; Money in ETB minor units.

**healthcare_providers** — aggregate root (extends Module 1 organization).
- `id`, `organization_id` (unique FK → organizations), `type` (HOSPITAL|CLINIC|DIAGNOSTIC_CENTER|LAB), `display_name`, `logo_url`, `description`, `website`, `contact_phone`, `contact_email`, `transacting_status` (ACTIVE|SUSPENDED|PENDING), `license_status`, `license_expires_at`, `rating_avg`, `rating_count`, `name_am`, `name_en`, `created_at`, `updated_at`, `deleted_at`.

**provider_locations** — branches.
- `id`, `provider_id` (FK), `name`, `region`, `city`, `subcity`, `woreda`, `address_line`, `lat`, `lng`, `phone`, `emergency_availability` (NONE|BUSINESS_HOURS|24_7), `is_primary`, `is_active`, `created_at`, `updated_at`, `deleted_at`.
- Geospatial index on (`lat`,`lng`) [PostGIS geography or geohash column].

**location_operating_hours**
- `id`, `location_id` (FK), `weekday`, `open_time`, `close_time`, `is_closed`.

**location_facilities** — amenities/capabilities.
- `id`, `location_id` (FK), `facility` (PARKING|AMBULANCE|ONSITE_PHARMACY|WHEELCHAIR|LAB|IMAGING|...), `notes`.

**departments** — hospital/clinic units.
- `id`, `provider_id` (FK), `name`, `specialty`, `description`, `contact_phone` (nullable), `is_active`, `created_at`.

**service_offerings** — lab tests / imaging / packages (diagnostics/labs).
- `id`, `provider_id` (FK), `location_id` (FK, nullable), `type` (LAB_TEST|IMAGING|SCREENING_PACKAGE), `name`, `code` (nullable, standardized test code), `description`, `price` (nullable), `currency` (ETB), `duration_minutes` (nullable), `preparation_instructions` (nullable), `attributes` (jsonb: modality e.g. MRI/CT, sample type), `is_available`, `created_at`, `updated_at`.

**provider_search_view** — denormalized read model.
- Flattened: `provider_id`, `type`, names (am/en), city, `lat`,`lng`, specialties (array), service names (array), `emergency_availability`, `rating_avg`, `search_tsv`. Refreshed via domain events.

**Relationships**
- `organizations 1—1 healthcare_providers`; `providers 1—N locations / departments / service_offerings`.
- `locations 1—N operating_hours / facilities`.
- `departments N—N doctors` (association owned/linked with Module 10 — via `department_doctors` join defined there or here by ID).
- References ratings (Module 13), doctors (Module 10).

**Rationale.** `provider_search_view` + geospatial index power nearest-first, filterable discovery (FR-HOSP-05/06, FR-LAB-04) without heavy joins on the hot path — same pattern as Module 3's catalog search, upgradeable to OpenSearch with geo later.

---

## 8. API Design

Base paths: `/api/v1/providers` (public discovery), `/api/v1/provider` (institution self-service portal), `/api/v1/admin/providers`. Public reads permissive; management Bearer + org-scoped. Envelope/errors per Module 1 §14.

### 8.1 Public Discovery
- **GET `/providers`** — search/filter. Query: `q, type, city, specialty, serviceType, emergency, lat, lng, radius, sort(distance|rating), page`. → nearest-first paginated results.
- **GET `/providers/{id}`** — full profile: locations, hours, departments/services, facilities, ratings.
- **GET `/providers/{id}/doctors`** — affiliated doctors (composed with Module 10) (FR-HOSP-08).
- **GET `/providers/{id}/services`** — service catalog (labs/diagnostics) with pricing/prep.
- **GET `/providers/nearby`** — `{ lat, lng, radius, type? }` → nearest providers (FR-HOSP-05).

### 8.2 Institution Portal (`provider:manage:org` — Hospital/Diagnostic Center Admin)
- **POST `/provider/register`** — create institution org (→ PENDING_APPROVAL) + trigger Module 1 verification.
- **GET/PATCH `/provider/profile`** — manage profile (sensitive changes re-moderated).
- **CRUD `/provider/locations`** + **PUT `/provider/locations/{id}/hours`** + **CRUD `/provider/locations/{id}/facilities`**.
- **CRUD `/provider/departments`** (hospitals/clinics).
- **CRUD `/provider/services`** (labs/diagnostics: tests/imaging/packages + pricing/prep).
- **GET `/provider/dashboard`** — profile completeness, verification status, bookings summary (composed with Modules 10/11).

### 8.3 Admin
- **GET `/admin/providers`** — list/filter (status, license expiry, type).
- **POST `/admin/providers/{id}/suspend|reactivate`** — manual (audited).
- **GET `/admin/providers/verification/queue`** — pending verifications (via Module 1). **approve/reject** delegate to Module 1.

**Representative errors:** `PROVIDER_NOT_ELIGIBLE, PROVIDER_NOT_VERIFIED, LICENSE_EXPIRED, PROVIDER_SUSPENDED, LOCATION_REQUIRES_GPS, SERVICE_NOT_ALLOWED_FOR_TYPE, PROVIDER_NOT_FOUND, RBAC_FORBIDDEN, VALIDATION_ERROR`.

---

## 9. NestJS Folder Structure (Clean Architecture)

```
src/modules/provider-directory/
  domain/
    entities/            # HealthcareProvider, ProviderLocation, Department, ServiceOffering
    value-objects/       # ProviderType, EthiopianAddress, GeoPoint, OperatingHours,
    │                    # EmergencyAvailability, Specialty, ServiceType, Money, PreparationInstructions
    events/              # ProviderRegistered, ProviderActivated, ProviderSuspended, ProfileUpdated,
    │                    # DepartmentAdded, ServiceOfferingAdded, ServiceOfferingUpdated
    enums/               # ProviderType, TransactingStatus, ServiceType, EmergencyAvailability
    repositories/        # IProviderRepository, ILocationRepository, IDepartmentRepository,
    │                    # IServiceOfferingRepository, IProviderSearchReadRepository
    services/            # ProviderEligibilityPolicy, ServiceTypeRule, GeoDistanceService
  application/
    commands/            # RegisterProvider, UpdateProfile, ManageLocation, ManageDepartment,
    │                    # ManageServiceOffering, SuspendProvider
    queries/             # SearchProviders, GetProvider, GetProviderServices, GetNearbyProviders, GetProviderDoctors
    ports/               # IIdentityPort(1: org/verification), IDoctorDirectoryPort(10),
    │                    # IReviewSummaryPort(13), IGeocodingPort, IStoragePort(images),
    │                    # ICachePort, ISearchIndexPort, IAuditPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*; ProviderSearchReadRepository (geo + tsvector)
    search/              # PgGeoSearchAdapter (ISearchIndexPort) [OpenSearch-geo later]
    storage/             # CloudStorageImageAdapter
    scheduling/          # LicenseExpirySweeper (shared pattern)
    ports-adapters/      # Identity/DoctorDirectory/ReviewSummary/Geocoding adapters
    cache/ audit/
  interface/
    http/
      controllers/       # ProviderDiscoveryController, ProviderPortalController, AdminProviderController
      dtos/ guards/ decorators/ filters/ interceptors/
    events/              # on ProviderSuspended → hide services + invalidate search cache;
    │                    # on profile change → refresh provider_search_view
  provider-directory.module.ts
```

**Rationale.** Doctors are owned by Module 10; this module reaches them via `IDoctorDirectoryPort` for bidirectional navigation (FR-HOSP-08), never by direct table access. `ProviderEligibilityPolicy` + the shared `LicenseExpirySweeper` mirror Module 4 for uniform compliance.

---

## 10. Sequence Flows

### 10.1 Register & Verify Institution (BRULE-07)
```
Provider → POST /provider/register {type, name, license docs}
RegisterProvider → IIdentityPort: create organization(type, PENDING_APPROVAL) + verification_request
RegisterProvider → save HealthcareProvider(PENDING)
... Admin reviews via Module 1 verification queue → APPROVED ...
Module 1 event ProviderApproved → ProviderActivated: transacting_status=ACTIVE
ProviderActivated → provider may now publish departments/services; refresh search view
RegisterProvider/Activate → IAuditPort
```

### 10.2 Publish Service Offering (eligibility-gated)
```
Provider → POST /provider/services {type: LAB_TEST, name, price, prep}
ManageServiceOffering → ProviderEligibilityPolicy.check  [403 PROVIDER_NOT_ELIGIBLE / LICENSE_EXPIRED]
ManageServiceOffering → ServiceTypeRule: type allowed for provider.type?  [SERVICE_NOT_ALLOWED_FOR_TYPE]
ManageServiceOffering → save ServiceOffering; emit ServiceOfferingAdded → refresh provider_search_view
→ 201
```

### 10.3 Nearest-First Discovery (FR-HOSP-05)
```
Client → GET /providers/nearby?lat&lng&radius&type=DIAGNOSTIC_CENTER
GetNearbyProviders → ICachePort hit? return
 miss → IProviderSearchReadRepository: geo query (PostGIS) eligible providers within radius
      → GeoDistanceService: distance + sort ascending
      → filter ineligible (ProviderEligibilityPolicy); attach ratings, services summary
      → cache snapshot (short TTL)
→ 200 [{provider, distance, emergency, services[]}]
```

### 10.4 Hospital ↔ Doctors Navigation (FR-HOSP-08)
```
Client → GET /providers/{id}/doctors
GetProviderDoctors → IDoctorDirectoryPort(Module 10).listByProvider(providerId, departmentId?)
→ 200 [{doctorId, name, specialty, department, nextAvailableSlot?}]
(reverse: Module 10 doctor detail → GET provider profiles via this module's port)
```

### 10.5 License Expiry Auto-Suspend (BRULE-08)
```
LicenseExpirySweeper (daily) → providers where license_expires_at ≤ now, status ACTIVE
 → set SUSPENDED; license_status=EXPIRED; hide services from search; invalidate cache
 → emit ProviderSuspended → notify; block appointment/test publishing (Modules 10/11)
 → IAuditPort: PROVIDER_AUTO_SUSPENDED
```

---

## 11. Error Handling

Reuses Module 1 §14. Eligibility/compliance errors are hard: `PROVIDER_NOT_ELIGIBLE`, `PROVIDER_NOT_VERIFIED`, `LICENSE_EXPIRED`, `PROVIDER_SUSPENDED` (BRULE-07/08), `LOCATION_REQUIRES_GPS` (nearest-first depends on it), `SERVICE_NOT_ALLOWED_FOR_TYPE`, `PROVIDER_NOT_FOUND`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 12. Logging & Auditing

Reuses hash-chained `audit_logs`. **Must-log:** provider registered, activated/suspended (manual + auto), verification outcomes (via Module 1), sensitive profile changes (name/license), department/service create/update/remove, service price changes. Operational logs track discovery latency + geo-query performance (NFR-PERF-01).

---

## 13. Future Scalability & Evolution

- **Geo-search at scale** — PostGIS/geohash now; move to OpenSearch with geo + facets behind `ISearchIndexPort` as the directory grows nationwide.
- **Read/cache scaling** — directory is read-dominant; Redis + CDN + read replicas; `provider_search_view` served from replicas.
- **Insurance integration (future, NFR-INTEROP-03)** — model accepted insurers as provider capability data; feeds "insurance acceptance" search filter (Vision).
- **Facility/capability taxonomy** — extensible facilities enable richer filtering (emergency, ICU, specific imaging).
- **Extraction-ready** — depends on Identity/Doctors/Reviews via ports; can become a standalone Directory service feeding an event-driven geo-search projection.

---

## Open Questions for Product/Compliance
1. **Accreditation/licensing bodies** — which Ethiopian authorities' licenses/accreditation must be verified per institution type (drives verification docs)?
2. **Provider self-registration vs admin-curated** — do institutions self-register, or does the platform onboard them initially (affects moderation load)?
3. **Standardized test/service codes** — adopt a coding standard (e.g., LOINC for lab tests) for `service_offerings.code` to enable interoperability?
4. **Pricing display** — will providers publish estimated prices at launch (FR-LAB-03), or is pricing deferred/on-request?
5. **Emergency directory** — should emergency/24-7 providers get a dedicated fast-access surface?

---

**End of Module 9 design.** Awaiting your approval to proceed. Recommended next module: **Doctor & Appointment** (doctor profiles, availability calendars, slot booking with no-double-booking, reschedule/cancel, reminders, waitlist — FR-APPT, BRULE-06/31/32/33), building directly on this directory.
