# Module 11 — Diagnostics & Lab Bookings (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 11 — Diagnostics & Lab Bookings (Test/imaging/package booking, home-sample collection, prep, result delivery)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity), 02 (Beneficiary/Address), 07 (Payment), 08 (Delivery — home collection), 09 (Provider Directory / ServiceOffering). Consumed by: Health Records (12/records), Notification, Reviews.
**Traceability:** FR-LAB-01..08, FR-REC-01/02/03, FR-NOT-05, BRULE-07, BRULE-35, BRULE-36, BRULE-37, NFR-SEC-02, NFR-PRIV, NFR-AUDIT

> Single source of truth for the Diagnostics & Lab Bookings bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module lets patients **book diagnostic services** (lab tests, imaging, screening packages) offered by verified diagnostic centers/labs (Module 9), optionally with **home sample collection**, follow **preparation instructions**, and **securely receive results** into their health records.

**Reuse over reinvention.** Diagnostics booking is structurally close to Module 10 (Doctor & Appointment): discover a service → pick a slot → pay → fulfill → deliver an outcome. This module **reuses the same patterns** — materialized slots + atomic hold (no double-booking), hold+TTL payment saga, beneficiary access policy — applied to `ServiceOffering`s from Module 9 rather than doctors. The genuinely new concerns are **home-sample collection logistics** and **secure result delivery** (a health-record artifact).

**Boundary.** Module 9 owns the *service catalog* (what tests exist, price, prep). This module owns the *booking + fulfillment + result*. Results become **health records** (owned by the Records module / Module 2 privacy rules); this module produces them and delegates storage/access to that domain.

**Primary objectives**
- Discover and book diagnostic services from verified providers (FR-LAB-01/05, BRULE-07).
- Support **at-center** and **home-sample-collection** modes (FR-LAB-06, BRULE-35).
- Surface **preparation instructions** and require acknowledgment (FR-LAB-02, BRULE-36).
- **Pay** before confirmation where required (Module 7).
- Manage the **specimen/fulfillment lifecycle**: collected → processing → result ready.
- **Securely deliver results** to the patient's health record with access control + audit (FR-LAB-07, FR-REC-01/02, NFR-SEC-02, BRULE-37).
- Notify patients at each step (FR-LAB-08, FR-NOT-05).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-LAB-01 | Patients can book tests/imaging/packages from verified providers. | FR-LAB-01/05, BRULE-07 |
| BR-LAB-02 | Booking supports at-center visit or home sample collection. | FR-LAB-06, BRULE-35 |
| BR-LAB-03 | Preparation instructions are shown and acknowledged before booking. | FR-LAB-02, BRULE-36 |
| BR-LAB-04 | Estimated price is shown; payment collected per policy. | FR-LAB-03 |
| BR-LAB-05 | Home collection is scheduled with a time window and address. | FR-LAB-06, BRULE-35 |
| BR-LAB-06 | Specimen/fulfillment status is tracked to result-ready. | FR-LAB-07 |
| BR-LAB-07 | Results are delivered securely to the patient's records. | FR-LAB-07, FR-REC-01, BRULE-37 |
| BR-LAB-08 | Results/records are encrypted and access-controlled. | NFR-SEC-02, FR-REC-02 |
| BR-LAB-09 | Patients (incl. beneficiaries) can book and view results per access policy. | FR-REC-03, BRULE-04 |
| BR-LAB-10 | Patients are notified of each status change and result availability. | FR-LAB-08, FR-NOT-05 |
| BR-LAB-11 | Bookings can be rescheduled/cancelled within policy. | (parity with Module 10) BRULE-32/33 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Discovery & Booking
- **F-LB-01** Browse a provider's diagnostic `ServiceOffering`s (tests/imaging/packages) with price/prep (via Module 9).
- **F-LB-02** Compare services across nearby diagnostic centers (price/distance) (FR-LAB-04, via Module 9 search).
- **F-LB-03** Select service(s), fulfillment mode (AT_CENTER | HOME_COLLECTION), and slot/time window.
- **F-LB-04** **Acknowledge preparation instructions** (fasting, etc.) before confirming (BRULE-36).
- **F-LB-05** Book for self or a beneficiary (Module 2 access policy).
- **F-LB-06** Pay if required (Module 7) before confirmation.
- **F-LB-07** Multi-test / package booking in one order.
- **F-LB-08** Reschedule/cancel within policy (BRULE-32/33 parity).

### 3.2 Slots & Home Collection
- **F-SL-01** At-center slots: provider capacity per location/time (materialized-slot pattern, reused from Module 10).
- **F-SL-02** Home-collection windows: schedule a collection time window + patient address (Module 2), assign a phlebotomist/collector (BRULE-35).
- **F-SL-03** Collector route/visit handled via Delivery-style dispatch (reuse Module 8 pattern) or provider's own staff.
- **F-SL-04** Capacity limits for home collection per area/day.

### 3.3 Fulfillment Lifecycle
- **F-FL-01** Status lifecycle: `BOOKED → (SAMPLE_COLLECTED | CHECKED_IN) → PROCESSING → RESULT_READY → COMPLETED`; branches `CANCELLED`, `NO_SHOW`, `SAMPLE_REJECTED` (recollect).
- **F-FL-02** Provider records sample collection / patient check-in.
- **F-FL-03** Provider marks processing and uploads result when ready.
- **F-FL-04** Sample rejection / recollection handling (quality issues).

### 3.4 Result Delivery (secure)
- **F-RS-01** Provider uploads result document(s) (PDF/image) — encrypted at rest (NFR-SEC-02).
- **F-RS-02** Result attached to patient's **health record** (Records domain), linked to the booking + beneficiary.
- **F-RS-03** Patient notified; views result via access-controlled, audited, pre-signed URL (BRULE-37, FR-REC-06).
- **F-RS-04** Optional structured result values (analyte, value, unit, reference range) for trends (future/where feasible).
- **F-RS-05** Share result with a doctor for an appointment/consultation (consented, Module 10/12).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Security/Privacy** | Results encrypted + access-controlled + audited (NFR-SEC-02, BRULE-37, FR-REC-06) | Envelope encryption; `BeneficiaryAccessPolicy` (Module 2) on every view; audit each access. |
| **Concurrency** | No slot/home-window overbooking | Reuse Module 10 materialized-slot atomic hold; capacity counters for home windows. |
| **Reliability** | Booking+payment consistent (NFR-AVAIL) | Hold+TTL + payment saga + outbox (same as Modules 6/10). |
| **Consistency** | Results tied to correct patient/beneficiary | Strong linkage booking↔beneficiary snapshot; provider cannot misattribute. |
| **Retention** | Health-record retention (BRULE-41) | Results stored under Records retention policy. |
| **Auditability** | Full booking + result-access trail (NFR-AUDIT) | Immutable status history + result access log. |
| **Extensibility** | Structured results/interop later (NFR-INTEROP) | Result model supports document now, structured analytes later (LOINC-ready). |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **DiagnosticBooking** (aggregate root) — a booking of one or more services with fulfillment mode + lifecycle.
- **BookingItem** (entity) — one booked `ServiceOffering` (test/imaging/package) + its per-item status/result link.
- **DiagnosticSlot** (entity) — at-center capacity slot (reuses Module 10 slot pattern).
- **HomeCollection** (entity) — scheduled window + address + assigned collector + visit status.
- **DiagnosticResult** (entity) — result artifact(s) + optional structured values; the health-record payload.
- **BookingStatusHistory** (immutable) — transitions.

### 5.2 Value Objects
- `FulfillmentMode` (AT_CENTER|HOME_COLLECTION), `PreparationAcknowledgment` (ackedAt), `CollectionWindow` (start/end + address snapshot), `BookingStatus`, `ItemStatus`, `ResultStatus` (PENDING|READY|AMENDED), `AnalyteValue` (name, value, unit, refRange), `Money` (ETB), `PatientRef` (customer + beneficiary snapshot).

### 5.3 Invariants
- Services bookable only from **verified, eligible** providers (Module 9 `ProviderEligibilityPolicy`, BRULE-07).
- **Preparation acknowledgment required** before confirming when the service has prep instructions (BRULE-36).
- At-center slot booking is **atomic** (no overbooking) — reuse Module 10 conditional-update hold; home-collection windows enforce **capacity counters** per area/day.
- Booking requiring a fee reaches `CONFIRMED` only after successful payment (Module 7).
- A `DiagnosticResult` is **immutable once issued**; corrections create an **AMENDED** version (never overwrite) — clinical integrity.
- Result access requires **beneficiary authorization** (Module 2) + is **audited** (BRULE-37, FR-REC-06).
- A result is always linked to the exact booking + beneficiary snapshot (no misattribution).

**Design rationale — result versioning (amend, never overwrite).** Diagnostic results are clinical documents; a correction must preserve the original for audit and safety. Modeling results as **immutable versions with AMENDED supersession** (like the ledger philosophy elsewhere) guarantees traceability and matches lab accreditation norms.

---

## 6. Home Sample Collection (BRULE-35)

The distinctive logistics concern. Two operating models, supported via config:

- **Provider-staffed:** the diagnostic center's own phlebotomist visits; scheduling uses `HomeCollection` windows with per-area/day capacity counters (no external dispatch).
- **Platform-dispatched:** reuse the **Module 8 dispatch pattern** to assign a collector to a home-collection "job" (pickup = patient address, dropoff = lab). This avoids reinventing assignment/tracking.

`HomeCollection` lifecycle: `SCHEDULED → COLLECTOR_ASSIGNED → EN_ROUTE → COLLECTED → DROPPED_AT_LAB` → merges into booking `PROCESSING`. Cold-chain/specimen-handling flags surface to the collector (parallels BRULE-30).

**Design rationale.** Rather than duplicate dispatch/tracking, home collection is expressed as a specialized delivery job when platform-dispatched (Module 8 `IDeliveryPort`), keeping one dispatch engine. For provider-staffed labs, a lightweight capacity-scheduled window suffices.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; Money in ETB minor units; results encrypted (envelope).

**diagnostic_bookings** — aggregate root.
- `id`, `booking_number` (unique), `patient_user_id` (FK), `beneficiary_snapshot` (jsonb), `provider_id` (FK → Module 9), `location_id` (FK → Module 9, nullable for home), `fulfillment_mode` (AT_CENTER|HOME_COLLECTION), `status`, `prep_acknowledged_at` (nullable), `total_price`, `currency` (ETB), `payment_id` (ref → Module 7, nullable), `scheduled_at` (nullable), `created_at`, `updated_at`.

**booking_items** — one per booked service.
- `id`, `booking_id` (FK), `service_offering_id` (FK → Module 9), `service_snapshot` (jsonb: name/type/prep), `price` (snapshot), `item_status`, `result_id` (FK → diagnostic_results, nullable), `created_at`.

**diagnostic_slots** — at-center capacity (reuses Module 10 pattern).
- `id`, `provider_id` (FK), `location_id` (FK), `service_type` (nullable), `start_at`, `end_at`, `capacity`, `booked_count` (derived), `status` (OPEN|FULL|BLOCKED), `created_at`.
- (Capacity-based: booking increments `booked_count` atomically while `< capacity`.)

**home_collections** — home-visit scheduling.
- `id`, `booking_id` (FK), `address_snapshot` (jsonb), `window_start`, `window_end`, `collector_user_id` (FK, nullable), `delivery_job_id` (ref → Module 8, nullable — platform-dispatched), `status` (SCHEDULED|COLLECTOR_ASSIGNED|EN_ROUTE|COLLECTED|DROPPED_AT_LAB|FAILED), `collected_at`, `created_at`.

**diagnostic_results** — immutable result versions (health-record payload).
- `id`, `booking_item_id` (FK), `version` (int), `status` (PENDING|READY|AMENDED), `supersedes_id` (nullable self-FK), `file_ref` (encrypted storage), `encryption_key_ref` (KMS), `issued_by_user_id` (FK), `issued_at`, `health_record_id` (ref → Records domain), `created_at`.

**result_analytes** — optional structured values (trends, LOINC-ready).
- `id`, `result_id` (FK), `analyte_name`, `code` (nullable, LOINC), `value`, `unit`, `reference_range`, `flag` (NORMAL|HIGH|LOW|CRITICAL, nullable).

**result_access_log** — every view/download (FR-REC-06, BRULE-37).
- `id`, `result_id` (FK), `actor_user_id` (FK), `role`, `access_type` (VIEW|DOWNLOAD|SHARE), `outcome` (ALLOW|DENY), `created_at`.

**booking_status_history** — immutable transitions.
- `id`, `booking_id` (FK), `from_status`, `to_status`, `actor_type`, `actor_id`, `reason`, `created_at`.

**Relationships**
- `diagnostic_bookings 1—N booking_items / booking_status_history`; `1—1 home_collections` (if home).
- `booking_items 1—1 diagnostic_results` (current) with version chain via `supersedes_id`.
- `diagnostic_results 1—N result_analytes / result_access_log`.
- References to Module 9 (provider/service), 7 (payment), 8 (delivery job), 2 (beneficiary), Records (health_record_id).

**Rationale.** At-center uses **capacity slots** (a diagnostic center runs many parallel tests, unlike a single doctor) — atomic `booked_count < capacity` increment prevents overbooking. Results are **versioned + encrypted**, linked to a health record, with a dedicated access log for the strict privacy/audit requirement (BRULE-37).

---

## 8. API Design

Base paths: `/api/v1/diagnostics` (patient), `/api/v1/provider/diagnostics` (lab portal). Bearer auth; beneficiary access via Module 2; result reads audited. Envelope/errors per Module 1 §14.

### 8.1 Discovery & Booking (patient)
- **GET `/diagnostics/services`** — search services (delegates to Module 9): `q, type, city, lat, lng, providerId`. → services + provider + price/prep.
- **GET `/diagnostics/providers/{id}/slots`** — at-center availability. **GET `/diagnostics/home-windows`** — `{ lat,lng,date }` available collection windows.
- **POST `/diagnostics/bookings`** — `{ providerId, items:[serviceOfferingId], mode, slotId? | window+addressId, beneficiaryId?, prepAcknowledged:true }` + `Idempotency-Key` → holds slot/window → `{ bookingId, status, paymentIntent? }`. Errors: `PREP_NOT_ACKNOWLEDGED` (BRULE-36), `SLOT_UNAVAILABLE`, `HOME_CAPACITY_FULL`.
- **POST `/diagnostics/bookings/{id}/pay`** — complete payment → CONFIRMED.
- **GET `/diagnostics/bookings`** / **`/{id}`** — my bookings (+ beneficiary, access-controlled).
- **POST `/diagnostics/bookings/{id}/reschedule|cancel`** — policy-checked (BRULE-32/33 parity).
- **GET `/diagnostics/bookings/{id}/result`** — access-controlled, **audited**, pre-signed URL (BRULE-37).
- **POST `/diagnostics/bookings/{id}/result/share`** — `{ doctorId }` consented share (Module 10/12).

### 8.2 Provider/Lab Portal (`diagnostics:manage:org`)
- **GET `/provider/diagnostics/bookings`** — incoming bookings (scoped to provider).
- **POST `/provider/diagnostics/bookings/{id}/check-in`** / **`/collect-sample`** — record arrival/collection.
- **POST `/provider/diagnostics/bookings/{id}/processing`** — mark processing.
- **POST `/provider/diagnostics/bookings/{itemId}/result`** — upload result `{ file, analytes? }` (encrypted) → RESULT_READY → attach to health record → notify (FR-LAB-08).
- **POST `/provider/diagnostics/results/{id}/amend`** — upload corrected version (new version, supersedes).
- **POST `/provider/diagnostics/bookings/{id}/reject-sample`** — `{ reason }` → recollection flow.
- **PUT `/provider/diagnostics/slots`** — manage capacity slots/home windows.

**Representative errors:** `PREP_NOT_ACKNOWLEDGED` (BRULE-36), `SLOT_UNAVAILABLE`, `HOME_CAPACITY_FULL` (BRULE-35), `PROVIDER_NOT_ELIGIBLE` (BRULE-07), `PAYMENT_REQUIRED`, `RESULT_NOT_READY`, `RESULT_ACCESS_DENIED` (BRULE-37), `BENEFICIARY_ACCESS_DENIED`, `RESCHEDULE_WINDOW_CLOSED`, `CANCELLATION_WINDOW_CLOSED`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 9. NestJS Folder Structure (Clean Architecture)

```
src/modules/diagnostics/
  domain/
    entities/            # DiagnosticBooking, BookingItem, DiagnosticSlot, HomeCollection,
    │                    # DiagnosticResult, BookingStatusHistory
    value-objects/       # FulfillmentMode, PreparationAcknowledgment, CollectionWindow,
    │                    # BookingStatus, ItemStatus, ResultStatus, AnalyteValue, Money, PatientRef
    events/              # BookingCreated, BookingConfirmed, SampleCollected, BookingProcessing,
    │                    # ResultReady, ResultAmended, BookingCancelled, SampleRejected
    enums/               # FulfillmentMode, BookingStatus, ItemStatus, ResultStatus, HomeCollectionStatus
    repositories/        # IBookingRepository, IDiagnosticSlotRepository, IHomeCollectionRepository,
    │                    # IResultRepository
    services/            # SlotCapacityService (atomic booked_count), PrepAckPolicy,
    │                    # ResultVersioningService, DiagnosticBookingPolicy (reschedule/cancel)
  application/
    commands/            # CreateBooking, PayBooking, RescheduleBooking, CancelBooking,
    │                    # CheckIn, CollectSample, MarkProcessing, UploadResult, AmendResult,
    │                    # RejectSample, ShareResult, ScheduleHomeCollection
    queries/             # SearchServices, GetSlots, GetHomeWindows, GetMyBookings, GetResult
    ports/               # IProviderDirectoryPort(9), IPaymentPort(7), IDeliveryPort(8 home collection),
    │                    # IBeneficiaryAccessPort(2), IRecordsPort (health record), IStoragePort(KMS enc),
    │                    # INotificationPort, IAuditPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*; SlotCapacityRepository atomic increment
    storage/             # EncryptedResultStorageAdapter (envelope enc)
    scheduling/          # HoldTtlSweeper, ReminderScheduler, HomeCapacityManager
    ports-adapters/      # ProviderDirectory/Payment/Delivery/Beneficiary/Records/Notification adapters
    audit/
  interface/
    http/
      controllers/       # DiagnosticsController (patient), ProviderDiagnosticsController
      dtos/ guards/       # BeneficiaryAccessGuard, ResultAccessGuard, PermissionsGuard, IdempotencyInterceptor
      decorators/ filters/ interceptors/  # AuditInterceptor on result reads
    events/              # on ResultReady→notify+attach record; on payment→confirm; home collection→IDeliveryPort
  diagnostics.module.ts
```

**Rationale.** Booking/slot/payment logic mirrors Module 10 (shared patterns), so this module stays small. The new logic — `ResultVersioningService` (immutable amend), `PrepAckPolicy`, encrypted result storage, and health-record delegation via `IRecordsPort` — is isolated and testable. Home collection reuses `IDeliveryPort` (Module 8) rather than a new dispatch engine.

---

## 10. Sequence Flows

### 10.1 Book (prep ack + capacity + payment, BRULE-35/36)
```
Patient → POST /diagnostics/bookings {items, mode, slotId|window, beneficiaryId?, prepAcknowledged} + Idempotency-Key
CreateBooking → PrepAckPolicy: services need prep & acked? else PREP_NOT_ACKNOWLEDGED
CreateBooking → IBeneficiaryAccessPort.check (if beneficiary)
CreateBooking → IProviderDirectoryPort.eligible(provider)?  [PROVIDER_NOT_ELIGIBLE]
CreateBooking → AT_CENTER: SlotCapacityService.hold (atomic booked_count<capacity) [SLOT_UNAVAILABLE]
             → HOME_COLLECTION: HomeCapacityManager.reserve window [HOME_CAPACITY_FULL]
CreateBooking → Booking(PENDING_PAYMENT) snapshots; fee? → IPaymentPort.authorize
→ {bookingId, paymentIntent?}
... payment success ...
PayBooking → Booking CONFIRMED; if home → IDeliveryPort.createCollectionJob (Module 8); notify
```

### 10.2 Fulfillment → Result (secure delivery, BRULE-37)
```
Provider → POST /provider/.../check-in|collect-sample → SAMPLE_COLLECTED/CHECKED_IN
Provider → /processing → PROCESSING
Provider → POST /provider/.../{itemId}/result {file, analytes}
UploadResult → IStoragePort: envelope-encrypt + store; ResultVersioningService: version 1, READY
UploadResult → IRecordsPort: attach to patient health record (link beneficiary)
UploadResult → item RESULT_READY; booking → RESULT_READY when all items done
UploadResult → emit ResultReady → INotificationPort (FR-LAB-08); IAuditPort
Patient → GET /diagnostics/bookings/{id}/result
GetResult → ResultAccessGuard: IBeneficiaryAccessPort.check → audit VIEW (BRULE-37)
 → pre-signed short-lived URL
```

### 10.3 Amend Result (immutable versioning)
```
Provider → POST /provider/diagnostics/results/{id}/amend {file, reason}
AmendResult → ResultVersioningService: new version, status AMENDED, supersedes=prev (prev retained)
AmendResult → IRecordsPort update pointer; notify patient; IAuditPort RESULT_AMENDED
```

### 10.4 Home Collection (platform-dispatched, BRULE-35)
```
PayBooking(home) → IDeliveryPort.createCollectionJob {pickup: patient address, dropoff: lab, window}
Module 8 dispatch → collector assigned → EN_ROUTE → COLLECTED → DROPPED_AT_LAB
Delivery events → HomeCollection status sync → booking PROCESSING when sample at lab
```

---

## 11. Error Handling

Reuses Module 1 §14. Privacy/compliance errors are hard: `RESULT_ACCESS_DENIED`/`BENEFICIARY_ACCESS_DENIED` (BRULE-37/04, generic 403 — no existence leak), `PREP_NOT_ACKNOWLEDGED` (BRULE-36), `HOME_CAPACITY_FULL`/`SLOT_UNAVAILABLE` (BRULE-35 capacity), `PROVIDER_NOT_ELIGIBLE` (BRULE-07), `RESULT_NOT_READY`, `PAYMENT_REQUIRED`, window-closed errors (BRULE-32/33 parity).

---

## 12. Logging & Auditing

Reuses hash-chained `audit_logs`; `booking_status_history`, `result_access_log`, result version chain are trails. **Must-log:** booking created/confirmed/cancelled/rescheduled, prep acknowledgment, sample collected/rejected, processing, **result uploaded/amended** (issuer), **every result view/download/share** (actor + role, BRULE-37/FR-REC-06), home-collection assignment/status. Result contents and clinical values never in plain operational logs.

---

## 13. Future Scalability & Evolution

- **Structured results & trends** — `result_analytes` (LOINC-ready) enables value trends/graphs and interoperability (NFR-INTEROP) without schema upheaval.
- **Reused dispatch** — home collection via Module 8 scales with the delivery fleet; no separate logistics stack.
- **Capacity modeling** — at-center capacity slots + home per-area/day counters partition by provider; cache hot availability.
- **Doctor integration** — result sharing feeds Consultation/Appointment (Module 10/12) for informed care; e-ordering of tests by doctors is a natural future addition.
- **Package/bundle pricing** — screening packages already modeled as a `ServiceOffering` type; promotions via Module 7 coupons.
- **Extraction-ready** — depends on Modules 2/7/8/9 + Records via ports; emits events; can split into a Diagnostics service with results feeding an event-driven records projection.

---

## Open Questions for Product/Compliance
1. **Home collection model** — provider-staffed vs platform-dispatched collectors at launch (drives Module 8 reuse depth)?
2. **Result release policy** — direct-to-patient immediately, or held for provider/doctor review first (some results are sensitive)? (BRULE-37 nuance)
3. **Structured results at MVP** — document-only first, or capture analyte values from launch for trends?
4. **Prep enforcement** — is explicit acknowledgment sufficient (BRULE-36), or must certain tests verify prep (e.g., fasting confirmation) at collection?
5. **Payment timing** — prepaid vs pay-at-center for diagnostics; refund rules on cancellation/sample rejection.
6. **Result retention** — regulatory retention for diagnostic results (ties to Records BRULE-41).

---

**End of Module 11 design.** Awaiting your approval to proceed. Recommended next module: **Consultation / Telemedicine & Health Records** — video/chat consultations (from telemedicine appointments), e-prescriptions issued by doctors, and the unified health-records vault (results, prescriptions, consult notes) with strict privacy/access (FR-CONS, FR-REC, BRULE-37..41).
