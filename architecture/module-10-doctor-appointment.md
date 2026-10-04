# Module 10 — Doctor & Appointment (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 10 — Doctor & Appointment (Doctor profiles, availability, slot booking, reschedule/cancel, reminders, waitlist)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity/doctor verification), 02 (Beneficiary/patient), 07 (consultation payment), 09 (Provider Directory). Consumed by: Consultation/Telemedicine, Notification, Reviews, Records.
**Traceability:** FR-DOC-01..06, FR-APPT-01..10, FR-REC-05, FR-NOT-04, BRULE-06, BRULE-31, BRULE-32, BRULE-33, BRULE-34, NFR-PERF-01, NFR-AVAIL, NFR-AUDIT

> Single source of truth for the Doctor & Appointment bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module manages **doctors as bookable healthcare professionals** and the **appointment lifecycle**: discover a doctor, view real availability, **book a slot without double-booking**, pay (if required), attend (in-person or telemedicine handoff), and reschedule/cancel within policy.

**Two concerns, one workflow.** *Doctor* (profile, specialties, affiliations, availability rules) and *Appointment* (the booking + its lifecycle) are distinct aggregates but share the booking workflow, so they live together. Doctors are Module 1 **users** with role DOCTOR (verified per BRULE-06); this module owns their **professional profile + schedule**, and the appointments booked against them.

**The hard problem — concurrency-safe slot booking (BRULE-31).** The core technical challenge is guaranteeing **no two patients book the same slot** under concurrent load. This drives the central design decision: **materialized, individually-lockable slots** rather than free-form time ranges (see §5–6).

**Primary objectives**
- Maintain **doctor profiles**: specialty, qualifications, experience, languages, consultation fee, affiliations to providers (FR-DOC-01/02/03, FR-HOSP-08).
- Let doctors define **availability schedules** (recurring + exceptions) generating bookable slots (FR-APPT-01, FR-DOC-05).
- **Book appointments** into slots with strict no-double-booking (FR-APPT-02, BRULE-31).
- Support **in-person and telemedicine** appointment types (FR-APPT-03), handing off to Consultation (Module 12).
- **Reschedule/cancel** within policy (FR-APPT-05/06, BRULE-32/33), with **waitlist** for full schedules (FR-APPT-09).
- Send **reminders** (FR-APPT-07, FR-NOT-04) and maintain appointment history (FR-APPT-08).
- Enforce **appointment payment** where required before confirmation (BRULE-34) via Module 7.

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-APT-01 | Doctors have verified professional profiles. | FR-DOC-01, BRULE-06 |
| BR-APT-02 | Doctors are searchable by specialty, name, provider, location. | FR-DOC-04 |
| BR-APT-03 | Doctors define availability; the system generates bookable slots. | FR-APPT-01, FR-DOC-05 |
| BR-APT-04 | A slot can be booked by only one patient (no double-booking). | FR-APPT-02, BRULE-31 |
| BR-APT-05 | Appointments support in-person and telemedicine types. | FR-APPT-03 |
| BR-APT-06 | Patients (incl. beneficiaries) can book, view, reschedule, and cancel. | FR-APPT-02/05/06 |
| BR-APT-07 | Cancellation/reschedule follow policy windows/fees. | BRULE-32, BRULE-33 |
| BR-APT-08 | Appointment reminders are sent to patient and doctor. | FR-APPT-07, FR-NOT-04 |
| BR-APT-09 | A waitlist is offered when preferred slots are full. | FR-APPT-09 |
| BR-APT-10 | Consultation fee is paid before confirmation where required. | FR-APPT-04, BRULE-34 |
| BR-APT-11 | Appointment history is retained and viewable. | FR-APPT-08, FR-REC-05 |
| BR-APT-12 | Doctors manage their schedule and view their appointments. | FR-DOC-05, FR-APPT-10 |
| BR-APT-13 | Bidirectional navigation doctor ↔ hospital/provider. | FR-HOSP-08 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Doctor Profile
- **F-DOC-01** Professional profile: specialty/sub-specialty, qualifications, years of experience, bio, languages, photo (FR-DOC-01).
- **F-DOC-02** Consultation fee(s) per appointment type (in-person/telemedicine) (FR-DOC-02).
- **F-DOC-03** Affiliations: link doctor to one or more providers/departments (Module 9) (FR-DOC-03, FR-HOSP-08).
- **F-DOC-04** Verified badge (from Module 1 verification, BRULE-06).
- **F-DOC-05** Independent vs affiliated practice (doctor may practice at multiple hospitals or independently).

### 3.2 Availability & Slot Generation
- **F-AVL-01** Define **recurring availability** (weekly patterns per location/type) (FR-APPT-01).
- **F-AVL-02** Define **exceptions**: time off, holidays, one-off availability (FR-DOC-05).
- **F-AVL-03** Slot duration + buffer configuration per doctor/appointment type.
- **F-AVL-04** **Generate materialized slots** from rules within a rolling booking horizon (e.g., 60 days).
- **F-AVL-05** Block/unblock individual slots (ad-hoc).
- **F-AVL-06** Per-location availability (a doctor at hospital A Mon, clinic B Tue).

### 3.3 Booking Lifecycle
- **F-BK-01** Search available slots for a doctor (by date range, type, location) (FR-APPT-01).
- **F-BK-02** **Book** a slot for self or a beneficiary (Module 2) — atomic, no double-booking (BRULE-31).
- **F-BK-03** Pay consultation fee if required (Module 7) before confirmation (BRULE-34).
- **F-BK-04** Reschedule to another open slot within policy (BRULE-32).
- **F-BK-05** Cancel within policy; fee/refund per rules (BRULE-33).
- **F-BK-06** No-show handling + status.
- **F-BK-07** Telemedicine appointments create a consultation session handoff (Module 12) (FR-APPT-03).
- **F-BK-08** Booking reason / symptoms note (optional, feeds consultation context).

### 3.4 Waitlist & Reminders
- **F-WL-01** Join waitlist for a fully-booked doctor/date (FR-APPT-09).
- **F-WL-02** On cancellation, notify waitlisted patients (first-come booking window).
- **F-RM-01** Reminders (configurable: 24h, 1h) to patient + doctor (FR-APPT-07, FR-NOT-04).

### 3.5 Doctor & Patient Views
- **F-VW-01** Doctor: calendar, upcoming/past appointments, patient notes (FR-APPT-10).
- **F-VW-02** Patient: upcoming/past appointments, join links, receipts (FR-APPT-08).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Concurrency** | No double-booking under load (BRULE-31) | Materialized slots + atomic conditional update / row lock on the slot. |
| **Performance** | Fast availability reads (NFR-PERF-01) | Pre-generated slots indexed by doctor+date; cache hot doctors. |
| **Reliability** | Booking + payment consistent (NFR-AVAIL) | Slot hold (pending) + payment saga + TTL release; outbox events. |
| **Correctness** | Reschedule/cancel windows enforced (BRULE-32/33) | `AppointmentPolicy` domain service (single home for time-window rules). |
| **Auditability** | Booking changes traced (NFR-AUDIT) | Immutable appointment status history + audit. |
| **Privacy** | Beneficiary/patient access controlled | Reuse Module 2 `BeneficiaryAccessPolicy` for booking on behalf. |
| **Scalability** | Many doctors/slots (NFR-SCAL) | Slot generation as background job; horizon-bounded; partition by doctor. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **DoctorProfile** (aggregate root) — professional identity, specialties, fees, affiliations.
- **AvailabilityRule** (entity) — recurring pattern / exception producing slots.
- **AppointmentSlot** (entity) — a concrete, materialized, individually-bookable time slot (the concurrency unit).
- **Appointment** (aggregate root) — a booking against a slot; owns lifecycle.
- **WaitlistEntry** (entity) — a patient waiting for availability.
- **AppointmentStatusHistory** (immutable) — transitions.

### 5.2 Value Objects
- `Specialty`, `Qualification`, `ConsultationFee` (Money per type), `AppointmentType` (IN_PERSON|TELEMEDICINE), `TimeSlot` (start/end + tz), `SlotStatus` (OPEN|HELD|BOOKED|BLOCKED), `AppointmentStatus`, `CancellationPolicy` (windows/fees), `PatientRef` (customer + beneficiary snapshot).

### 5.3 Invariants (concurrency- & policy-critical)
- A doctor may publish availability/appointments **only if verified** (Module 1, BRULE-06).
- An `AppointmentSlot` has exactly one active booking: transition `OPEN → HELD → BOOKED` is **atomic**; a second concurrent booking attempt on the same slot must fail (BRULE-31).
- A `HELD` slot has a **TTL**; if payment isn't completed in the window, it auto-releases to `OPEN` (prevents slot lockup).
- Reschedule/cancel allowed only within policy windows (BRULE-32/33); outside window → blocked or fee applies.
- Booking for a **beneficiary** requires authorization via Module 2 `BeneficiaryAccessPolicy`.
- Appointment requiring a fee reaches `CONFIRMED` **only** after successful payment (BRULE-34).
- Every status change appends to history + emits an event (no silent mutation).

**Design rationale — materialized slots as the concurrency unit.** Instead of storing free-form availability ranges and computing conflicts at booking time (which is race-prone and hard to lock), the system **pre-generates discrete `AppointmentSlot` rows**. Booking becomes an **atomic conditional update on a single slot row** (`UPDATE ... SET status=HELD WHERE id=? AND status=OPEN`). This is the simplest correct primitive for no-double-booking (BRULE-31): the database guarantees exactly one winner. It also makes availability reads trivial (query OPEN slots) and cacheable.

---

## 6. Concurrency-Safe Booking (BRULE-31)

The correctness core, mirroring Module 4's reservation pattern:

- **Hold:** `UPDATE appointment_slots SET status='HELD', held_by=?, held_until=now+TTL WHERE id=? AND status='OPEN'`. If **0 rows updated** → slot taken → `SLOT_UNAVAILABLE`. If 1 row → hold acquired. This single atomic statement is the anti-double-booking guarantee (no explicit lock needed; the conditional predicate enforces it).
- **Confirm:** after payment success (or immediately if no fee), `HELD → BOOKED`, create `Appointment(CONFIRMED)`.
- **Release:** on payment fail/cancel/TTL, `HELD → OPEN` (slot bookable again). A sweeper releases expired holds.
- **Reschedule:** hold the new slot first, then release the old (never leave the patient with neither) — both in one transaction.

**Design rationale.** The conditional `UPDATE ... WHERE status='OPEN'` is atomic at the DB level and needs no distributed lock, making it correct and cheap even at high concurrency. The hold+TTL mirrors stock reservation (Module 4) so the payment saga integrates identically.

---

## 7. Appointment State Machine

**States:** `PENDING_PAYMENT → CONFIRMED → CHECKED_IN → IN_PROGRESS → COMPLETED`; branches: `CANCELLED`, `NO_SHOW`, `RESCHEDULED`, `EXPIRED` (hold expired pre-payment).

| From | Event | To | Guard |
| --- | --- | --- | --- |
| (book) | slot held, fee required | PENDING_PAYMENT | slot HELD |
| PENDING_PAYMENT | payment success / no fee | CONFIRMED | BRULE-34; slot→BOOKED |
| PENDING_PAYMENT | payment fail / TTL | EXPIRED | release slot |
| CONFIRMED | reschedule (within window) | RESCHEDULED→(new)CONFIRMED | BRULE-32 |
| CONFIRMED | cancel (within window) | CANCELLED | BRULE-33; refund per policy; release slot; notify waitlist |
| CONFIRMED | patient arrives / joins | CHECKED_IN | — |
| CHECKED_IN | consultation starts | IN_PROGRESS | telemedicine → Module 12 session |
| IN_PROGRESS | consultation ends | COMPLETED | enables review + record |
| CONFIRMED/CHECKED_IN | no-show | NO_SHOW | policy fee |

---

## 8. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; Money in ETB minor units.

**doctor_profiles** — aggregate root (references Module 1 user).
- `id`, `user_id` (unique FK → users, role DOCTOR), `specialty`, `sub_specialties` (array), `qualifications` (jsonb), `years_experience`, `bio`, `languages` (array), `photo_url`, `consultation_fee_in_person`, `consultation_fee_tele`, `currency` (ETB), `is_verified` (mirror Module 1), `accepts_telemedicine` (bool), `rating_avg`, `rating_count`, `created_at`, `updated_at`, `deleted_at`.

**doctor_affiliations** — doctor ↔ provider/department (Module 9).
- `id`, `doctor_id` (FK), `provider_id` (FK → Module 9), `department_id` (FK, nullable), `role_title`, `is_primary`, `created_at`. (Powers FR-HOSP-08 both directions.)

**availability_rules** — recurring patterns + exceptions.
- `id`, `doctor_id` (FK), `provider_location_id` (FK, nullable), `type` (RECURRING|EXCEPTION_AVAILABLE|EXCEPTION_BLOCK), `weekday` (nullable), `start_time`, `end_time`, `valid_from`, `valid_to`, `slot_duration_minutes`, `buffer_minutes`, `appointment_type` (IN_PERSON|TELEMEDICINE|BOTH), `created_at`.

**appointment_slots** — materialized bookable slots (concurrency unit).
- `id`, `doctor_id` (FK), `provider_location_id` (FK, nullable), `start_at`, `end_at`, `appointment_type`, `status` (OPEN|HELD|BOOKED|BLOCKED), `held_by` (nullable), `held_until` (nullable), `appointment_id` (nullable FK), `created_at`, `updated_at`.
- Unique (`doctor_id`,`start_at`,`appointment_type`); index (`doctor_id`,`start_at`,`status`) for availability queries.

**appointments** — aggregate root.
- `id`, `slot_id` (FK), `doctor_id` (FK), `patient_user_id` (FK), `beneficiary_snapshot` (jsonb), `appointment_type`, `status`, `reason_note` (encrypted, nullable), `fee` (snapshot), `payment_id` (ref → Module 7, nullable), `consultation_session_id` (ref → Module 12, nullable), `scheduled_start`, `scheduled_end`, `rescheduled_from_id` (nullable), `cancel_reason`, `created_at`, `updated_at`.

**appointment_status_history** — immutable transitions.
- `id`, `appointment_id` (FK), `from_status`, `to_status`, `actor_type`, `actor_id`, `reason`, `created_at`.

**waitlist_entries**
- `id`, `doctor_id` (FK), `patient_user_id` (FK), `beneficiary_id` (nullable), `preferred_date`, `appointment_type`, `status` (WAITING|NOTIFIED|BOOKED|EXPIRED), `notified_at`, `created_at`.

**Relationships**
- `doctor_profiles 1—N affiliations / availability_rules / appointment_slots / waitlist_entries`.
- `appointment_slots 1—1 appointments`; `appointments 1—N status_history`.
- References to Module 1 (user), 2 (beneficiary), 7 (payment), 9 (provider/location), 12 (session).

**Rationale.** Slots are pre-materialized by a background generator from `availability_rules` within a rolling horizon; the unique `(doctor, start_at, type)` + conditional-update pattern is the no-double-booking guarantee. `reason_note` is encrypted (health-sensitive, reuse Module 2/5 field-encryption approach).

---

## 9. API Design

Base paths: `/api/v1/doctors` (public discovery), `/api/v1/appointments` (patient), `/api/v1/doctor` (doctor portal). Bearer auth; beneficiary booking via Module 2 policy. Envelope/errors per Module 1 §14.

### 9.1 Public Discovery
- **GET `/doctors`** — search/filter: `q, specialty, providerId, location, type, availableOn, page`. Nearest/next-available sort (FR-DOC-04).
- **GET `/doctors/{id}`** — profile + affiliations + rating + next available slots.
- **GET `/doctors/{id}/slots`** — `{ from, to, type, locationId? }` → OPEN slots (availability, FR-APPT-01).

### 9.2 Appointments (patient)
- **POST `/appointments`** — `{ doctorId, slotId, beneficiaryId?, type, reasonNote? }` + `Idempotency-Key` → holds slot, returns `{ appointmentId, status, paymentIntent? }` (BRULE-31/34).
- **POST `/appointments/{id}/pay`** — complete consultation fee (Module 7) → CONFIRMED.
- **GET `/appointments`** — my appointments (+ beneficiary, access-controlled). **GET `/appointments/{id}`** — detail + join link (telemedicine).
- **POST `/appointments/{id}/reschedule`** — `{ newSlotId }` → policy-checked (BRULE-32). Errors: `RESCHEDULE_WINDOW_CLOSED`, `SLOT_UNAVAILABLE`.
- **POST `/appointments/{id}/cancel`** — `{ reason }` → policy + refund (BRULE-33). Errors: `CANCELLATION_WINDOW_CLOSED`.
- **POST `/doctors/{id}/waitlist`** — join waitlist (FR-APPT-09).

### 9.3 Doctor Portal (`doctor:manage:self`)
- **GET/PATCH `/doctor/profile`** — manage profile/fees.
- **CRUD `/doctor/affiliations`** — link providers/departments (Module 9).
- **CRUD `/doctor/availability`** — recurring rules + exceptions → triggers slot regeneration.
- **POST `/doctor/slots/{id}/block`** / **`/unblock`** — ad-hoc.
- **GET `/doctor/appointments`** — calendar/list (FR-APPT-10). **POST `/doctor/appointments/{id}/no-show`** / **`/complete`**.

**Representative errors:** `SLOT_UNAVAILABLE` (double-book prevented, BRULE-31), `SLOT_HOLD_EXPIRED`, `RESCHEDULE_WINDOW_CLOSED`, `CANCELLATION_WINDOW_CLOSED` (BRULE-32/33), `DOCTOR_NOT_VERIFIED` (BRULE-06), `PAYMENT_REQUIRED` (BRULE-34), `BENEFICIARY_ACCESS_DENIED`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/doctor-appointment/
  domain/
    entities/            # DoctorProfile, AvailabilityRule, AppointmentSlot, Appointment,
    │                    # WaitlistEntry, AppointmentStatusHistory
    value-objects/       # Specialty, ConsultationFee, AppointmentType, TimeSlot, SlotStatus,
    │                    # AppointmentStatus, CancellationPolicy, PatientRef
    events/              # AppointmentBooked, AppointmentConfirmed, AppointmentCancelled,
    │                    # AppointmentRescheduled, AppointmentCompleted, NoShowRecorded,
    │                    # SlotReleased, WaitlistNotified
    enums/               # SlotStatus, AppointmentStatus, AppointmentType, WaitlistStatus
    repositories/        # IDoctorRepository, IAvailabilityRepository, ISlotRepository,
    │                    # IAppointmentRepository, IWaitlistRepository
    services/            # SlotBookingService (atomic hold), AppointmentPolicy (reschedule/cancel windows),
    │                    # SlotGenerator, WaitlistService
  application/
    commands/            # BookAppointment, PayAppointment, RescheduleAppointment, CancelAppointment,
    │                    # ManageAvailability, BlockSlot, RecordNoShow, CompleteAppointment, JoinWaitlist
    queries/             # SearchDoctors, GetDoctor, GetDoctorSlots, GetMyAppointments, GetDoctorCalendar
    ports/               # IPaymentPort(7), IIdentityPort(1 doctor verify), IBeneficiaryAccessPort(2),
    │                    # IProviderDirectoryPort(9), IConsultationPort(12), INotificationPort,
    │                    # IAuditPort, ICachePort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/       # Prisma*; SlotRepository conditional-update (atomic hold)
    scheduling/          # SlotGeneratorJob (rolling horizon), HoldTtlSweeper, ReminderScheduler,
    │                    # WaitlistNotifier
    ports-adapters/      # Payment/Identity/Beneficiary/ProviderDirectory/Consultation/Notification adapters
    audit/ cache/
  interface/
    http/
      controllers/       # DoctorDiscoveryController, AppointmentController, DoctorPortalController
      dtos/ guards/       # BeneficiaryAccessGuard, PermissionsGuard, IdempotencyInterceptor
      decorators/ filters/ interceptors/  # AuditInterceptor
    events/              # on AppointmentCancelled→WaitlistNotifier; on Confirmed(telemed)→IConsultationPort.createSession
  doctor-appointment.module.ts
```

**Rationale.** `SlotBookingService` (atomic hold), `AppointmentPolicy` (time-window rules), and `SlotGenerator` are pure domain services — the concurrency and policy logic has one testable home. Cross-module effects (payment, verification, beneficiary access, provider directory, telemedicine session) go through ports. `IProviderDirectoryPort` ↔ Module 9's `IDoctorDirectoryPort` implement bidirectional navigation (FR-HOSP-08).

---

## 11. Sequence Flows

### 11.1 Book (no-double-booking + payment, BRULE-31/34)
```
Patient → POST /appointments {doctorId, slotId, beneficiaryId?} + Idempotency-Key
BookAppointment → IBeneficiaryAccessPort.check (if beneficiary)  [BENEFICIARY_ACCESS_DENIED]
BookAppointment → SlotBookingService.hold:
   UPDATE slots SET HELD WHERE id=? AND status=OPEN  → 0 rows? SLOT_UNAVAILABLE
BookAppointment → create Appointment(PENDING_PAYMENT) snapshot fee
  fee required → IPaymentPort.authorize (Module 7) → return paymentIntent
  no fee       → confirm directly
→ {appointmentId, status, paymentIntent?}
... payment success (webhook) ...
PayAppointment → slot HELD→BOOKED; Appointment CONFIRMED; outbox(AppointmentConfirmed)
  telemedicine → IConsultationPort.createSession (Module 12)
  → notify patient+doctor (FR-NOT-04); schedule reminders
 (payment fail/TTL → HoldTtlSweeper → slot OPEN; Appointment EXPIRED)
```

### 11.2 Reschedule (BRULE-32)
```
Patient → POST /appointments/{id}/reschedule {newSlotId}
RescheduleAppointment → AppointmentPolicy: within reschedule window?  [RESCHEDULE_WINDOW_CLOSED]
RescheduleAppointment → TX: hold newSlot (atomic) [SLOT_UNAVAILABLE]; release oldSlot→OPEN
RescheduleAppointment → Appointment→RESCHEDULED→new CONFIRMED; history; notify; waitlist(old slot)
```

### 11.3 Cancel + Waitlist (BRULE-33, FR-APPT-09)
```
Patient → POST /appointments/{id}/cancel {reason}
CancelAppointment → AppointmentPolicy: window? fee?  [CANCELLATION_WINDOW_CLOSED]
CancelAppointment → IPaymentPort.refund (per policy); slot→OPEN; Appointment CANCELLED
CancelAppointment → emit AppointmentCancelled → WaitlistNotifier: notify next waiting patient(s)
   → NOTIFIED with short booking window
```

### 11.4 Slot Generation (background)
```
SlotGeneratorJob (scheduled) → for each doctor: expand availability_rules within horizon
 → create OPEN appointment_slots (idempotent on unique doctor+start+type)
 → apply EXCEPTION_BLOCK rules (mark BLOCKED); prune past slots
```

---

## 12. Error Handling

Reuses Module 1 §14. Booking errors are hard and drive UX retry: `SLOT_UNAVAILABLE` (atomic hold lost — the double-booking guard, BRULE-31), `SLOT_HOLD_EXPIRED`, `RESCHEDULE_WINDOW_CLOSED`/`CANCELLATION_WINDOW_CLOSED` (BRULE-32/33), `DOCTOR_NOT_VERIFIED` (BRULE-06), `PAYMENT_REQUIRED`/`PAYMENT_FAILED` (BRULE-34, saga compensates by releasing slot), `BENEFICIARY_ACCESS_DENIED`, `RBAC_FORBIDDEN`.

---

## 13. Logging & Auditing

Reuses hash-chained `audit_logs`; `appointment_status_history` is an immutable trail. **Must-log:** appointment booked/confirmed/cancelled/rescheduled/completed/no-show (actor + reason), payment link/refund, availability changes + slot block/unblock, waitlist join/notify, access to beneficiary appointment data (FR-REC-06). `reason_note`/clinical content never in plain logs. Reminder dispatches logged operationally.

---

## 14. Future Scalability & Evolution

- **Slot scaling** — generation is a horizon-bounded background job; partition slots by doctor; cache hot doctors' OPEN slots; prune past slots.
- **Booking throughput** — the conditional-update hold is lock-free and scales; can shard by doctor with no logic change.
- **Group/recurring appointments** — availability model extends to recurring patient bookings (chronic care) later.
- **Smart scheduling (future)** — suggest optimal slots, reduce no-shows via ML on the appointment history (behind services, no schema upheaval).
- **Calendar sync** — export/import (iCal/Google) for doctors via an adapter port.
- **Extraction-ready** — depends on Modules 1/2/7/9/12 via ports and emits events; Appointment is a clean candidate service; slot store could move to its own DB.

---

## Open Questions for Product/Compliance
1. **Cancellation/reschedule windows & fees** — exact windows (e.g., free >24h, fee <24h) and no-show fee policy (BRULE-32/33).
2. **Consultation fee timing** — pay-to-confirm for all (BRULE-34), or pay-at-visit for in-person with only telemedicine prepaid?
3. **Booking horizon & slot duration defaults** — rolling horizon length (30/60/90 days) and default slot length per specialty.
4. **Waitlist policy** — how many waitlisted patients notified per opening, and their booking window before offering the next.
5. **Doctor verification authority** — which body's credentials verify doctors (BRULE-06); tie to Module 9 licensing bodies.
6. **Independent doctors** — can doctors operate without a provider affiliation, and how does that affect discovery/location?

---

**End of Module 10 design.** Awaiting your approval to proceed. Recommended next module: **Diagnostics & Lab Bookings** — booking `ServiceOffering`s from Module 9 (tests/imaging/packages), home-sample collection, prep instructions, and result delivery to health records (FR-LAB, FR-REC), reusing this module's slot/booking and payment patterns.
