# Module 12 — Consultation / Telemedicine & Health Records (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 12 — Consultation / Telemedicine & Health Records (Video/chat consults, e-prescriptions, unified records vault)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity), 02 (Beneficiary access policy), 05 (Prescription — Rx model), 10 (Appointment), 11 (Diagnostics results). Consumed by: Prescription/Order (e-Rx fulfillment), Notification, Reviews.
**Traceability:** FR-CONS-01..08, FR-REC-01..06, FR-NOT-06, BRULE-10, BRULE-37, BRULE-38, BRULE-39, BRULE-40, BRULE-41, NFR-SEC-02/10, NFR-PRIV, NFR-AUDIT, NFR-PERF-04

> Single source of truth for the Consultation & Health Records bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module delivers **telemedicine consultations** (secure video/chat between patient and doctor, launched from a telemedicine appointment), lets doctors **issue e-prescriptions** during/after a consult, and provides the **unified Health Records vault** — the patient's aggregated medical history (consult notes, e-prescriptions, diagnostic results, uploaded documents) with strict privacy and access control.

**Two concerns, one privacy domain.** *Consultation* (the live session + clinical output) and *Health Records* (the durable, aggregated vault) are distinct but deeply linked: a consultation **produces** records (notes, e-Rx), and records **inform** a consultation (doctor views history with consent). Both are governed by the same **health-data privacy rules** (BRULE-37, Module 2 `BeneficiaryAccessPolicy`), so they share this bounded context.

**Health Records as an aggregation layer.** Records don't re-store everything — the vault is a **unified index/timeline** over health artifacts owned by their source modules (diagnostic results in Module 11, prescriptions in Module 5, consult notes here), plus patient-uploaded documents. This realizes FR-REC-01's "consolidated view" without duplicating source-of-truth data (extends Module 2's `/records/timeline` idea into a full domain).

**Primary objectives**
- Conduct **secure video/chat consultations** from telemedicine appointments (FR-CONS-01/02, NFR-SEC-10, NFR-PERF-04).
- Let doctors record **consultation notes/diagnosis** and issue **e-prescriptions** (FR-CONS-03/04, BRULE-38).
- Ensure **e-prescriptions flow into the pharmacy Rx/order pipeline** (Module 5/6) as valid, doctor-issued prescriptions (BRULE-10/38).
- Provide a **unified, consolidated health-records timeline** (FR-REC-01) aggregating results, prescriptions, consults, uploads.
- Enforce **encryption, access control, consent, and audit** on all health data (FR-REC-02/03/06, BRULE-37/39, NFR-SEC-02).
- Support **consented sharing** of records with doctors/providers (FR-REC-04, BRULE-39).
- Honor **retention & patient data rights** (FR-REC-05, BRULE-40/41).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-CR-01 | Telemedicine appointments enable secure video/chat consultation. | FR-CONS-01/02, BRULE-38 |
| BR-CR-02 | Only the assigned doctor and patient join a session (+ authorized). | NFR-SEC-10, BRULE-37 |
| BR-CR-03 | Doctors record consultation notes and diagnosis. | FR-CONS-03 |
| BR-CR-04 | Doctors issue e-prescriptions during/after consultation. | FR-CONS-04, BRULE-38 |
| BR-CR-05 | E-prescriptions are valid for pharmacy fulfillment. | BRULE-10, BRULE-38 |
| BR-CR-06 | Consultation history and outputs are saved to health records. | FR-CONS-05, FR-REC-01 |
| BR-CR-07 | Patients have a consolidated view of their medical records. | FR-REC-01 |
| BR-CR-08 | Health records are encrypted and access-controlled. | FR-REC-02, NFR-SEC-02 |
| BR-CR-09 | Patients control who can access their records (consent). | FR-REC-03/04, BRULE-39 |
| BR-CR-10 | All record access is logged/audited. | FR-REC-06, BRULE-37 |
| BR-CR-11 | Records follow retention and patient data-rights policy. | FR-REC-05, BRULE-40/41 |
| BR-CR-12 | Consultation parties are notified/reminded. | FR-CONS-06, FR-NOT-06 |
| BR-CR-13 | Follow-up consultations can reference prior ones. | FR-CONS-07 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Consultation / Telemedicine
- **F-CS-01** Create a **consultation session** when a telemedicine appointment is confirmed (from Module 10).
- **F-CS-02** Secure **video/chat** via a real-time provider (WebRTC/SFU) with **short-lived, per-session tokens** (NFR-SEC-10).
- **F-CS-03** Waiting room + join controls; only assigned doctor + patient (or authorized guardian) admitted (BRULE-37).
- **F-CS-04** In-consult **chat** + file/image share (e.g., patient shows a rash, shares a prior result).
- **F-CS-05** Session lifecycle: scheduled → in-progress → ended; duration + participation recorded.
- **F-CS-06** Connection resilience/reconnect; graceful degradation to chat-only on poor networks (NFR-LOC-04).
- **F-CS-07** Follow-up consultation referencing a prior session (FR-CONS-07).

### 3.2 Clinical Output
- **F-CO-01** Doctor records **consultation notes**, diagnosis, advice (structured + free text) (FR-CONS-03).
- **F-CO-02** Doctor issues **e-prescription**: select catalog products, dosage, quantity, refills, instructions (FR-CONS-04).
- **F-CO-03** E-prescription is a **doctor-issued, pre-verified prescription** in Module 5 (skips patient-upload verification path) (BRULE-38).
- **F-CO-04** Order/lab recommendations (suggest diagnostic tests → Module 11).
- **F-CO-05** Consultation summary generated + delivered to patient records (FR-CONS-05).

### 3.3 Health Records Vault
- **F-HR-01** **Unified timeline** aggregating: consult notes/summaries, e-prescriptions (5), diagnostic results (11), appointments (10), uploaded documents (FR-REC-01).
- **F-HR-02** Patient **uploads** own documents (past records, external results) — encrypted (FR-REC-02).
- **F-HR-03** Per-beneficiary records (family), governed by Module 2 access policy (FR-REC-03).
- **F-HR-04** Record detail view with access-controlled, audited, pre-signed artifact URLs (FR-REC-06, BRULE-37).
- **F-HR-05** **Consent management**: grant/revoke record access to a doctor/provider, time-boxed (FR-REC-04, BRULE-39).
- **F-HR-06** Export / data-rights requests (portability, deletion within legal limits) (FR-REC-05, BRULE-40).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Security/Privacy** | E2E-secure sessions; encrypted records (NFR-SEC-02/10, BRULE-37) | SFU with per-session short-lived tokens; media not persisted by default; envelope-encrypted artifacts. |
| **Access Control** | Consent-driven, audited (FR-REC-03/04/06, BRULE-39) | `RecordAccessPolicy` (extends Module 2 `BeneficiaryAccessPolicy`) + consent grants + access log on every read. |
| **Performance** | Low-latency video (NFR-PERF-04) | SFU/media server (managed provider); adaptive bitrate; TURN for NAT traversal. |
| **Reliability** | Consult resilient on poor networks (NFR-LOC-04) | Reconnect logic; chat fallback; session state server-authoritative. |
| **Integrity** | Clinical outputs immutable/audited | Notes/e-Rx versioned + append-only; e-Rx locked once issued. |
| **Retention/Rights** | Retention + deletion rights (BRULE-40/41) | Retention policy per artifact type; legal-hold aware; deletion = withdraw+tombstone within limits. |
| **Auditability** | Full access + clinical trail (NFR-AUDIT) | Hash-chained audit + dedicated record access log. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **ConsultationSession** (aggregate root) — a telemedicine session: participants, lifecycle, media/chat refs.
- **ConsultationNote** (entity) — doctor's clinical notes/diagnosis for a session (versioned).
- **EPrescription** (entity) — a doctor-issued prescription (bridges to Module 5 as a pre-verified prescription).
- **ChatMessage** (entity) — in-session messages + shared files.
- **HealthRecord** (aggregate root) — an entry in the patient's vault: a typed reference to a health artifact.
- **RecordConsent** (entity) — a time-boxed grant of record access to a doctor/provider.
- **RecordAccessLog** (immutable) — every access to any record/artifact.

### 5.2 Value Objects
- `SessionStatus` (SCHEDULED|WAITING|IN_PROGRESS|ENDED|CANCELLED), `Participant` (userId + role + join/leave), `MediaToken` (short-lived), `RecordType` (CONSULT_NOTE|E_PRESCRIPTION|DIAGNOSTIC_RESULT|APPOINTMENT|UPLOADED_DOC), `ArtifactRef` (sourceModule + sourceId + storageRef), `ConsentScope` (recordTypes + validFrom/validUntil), `Diagnosis` (coded/free), `AccessOutcome` (ALLOW|DENY).

### 5.3 Invariants (privacy- & safety-critical)
- Only the **assigned doctor + patient** (or authorized guardian per Module 2) may join a `ConsultationSession`; tokens are **short-lived and per-participant** (BRULE-37, NFR-SEC-10).
- An **e-prescription** may be issued **only by a verified doctor** within/after a valid consultation (BRULE-38); once issued it is **immutable** and registered in Module 5 as APPROVED/doctor-issued (BRULE-10) with dispensing controls (BRULE-12) applying.
- Every access to a health record/artifact requires an **authorization decision** (`RecordAccessPolicy`) and is **logged** (FR-REC-06, BRULE-37) — no exceptions, including doctors.
- A doctor accesses a patient's broader records **only with an active `RecordConsent`** (BRULE-39); consent is time-boxed and revocable.
- Health records are an **aggregation** — the vault stores typed references + metadata; source modules remain the authority (no duplicate source-of-truth).
- Clinical notes are **versioned/append-only**; corrections add versions (integrity).
- Deletion requests honor **retention/legal hold** (BRULE-40/41) — hard delete only when legally permissible; otherwise access withdrawn + tombstoned.

**Design rationale — records as an aggregation index, not a data lake.** Re-storing diagnostic results/prescriptions in a records table would create dual sources of truth and sync bugs. Instead, `HealthRecord` holds a **typed reference** (`RecordType` + `ArtifactRef`) into the owning module; the vault composes a unified timeline while each artifact stays authoritative and independently access-controlled. Consent + access logging live at this aggregation layer so privacy is enforced uniformly.

---

## 6. Telemedicine Architecture (FR-CONS-01/02, NFR-SEC-10)

- **Signaling** — our WebSocket gateway coordinates session join/offer/answer/ICE; issues **short-lived media tokens** scoped to a session + participant.
- **Media** — a managed **SFU** (Selective Forwarding Unit, e.g., LiveKit/Janus/Twilio) relays audio/video; **media is not recorded/persisted by default** (privacy). TURN servers handle NAT traversal for reliability on Ethiopian networks (NFR-LOC-04).
- **Access control** — join requires a valid appointment (Module 10) + identity check; only assigned doctor/patient/guardian admitted (waiting-room admit).
- **Chat/files** — chat messages persisted (part of consult record where clinically relevant); shared files envelope-encrypted.
- **Resilience** — server-authoritative session state; reconnect tokens; automatic fallback to chat-only if media fails (NFR-LOC-04).

**Design rationale.** Using a managed SFU behind an `IRealtimeMediaPort` avoids building WebRTC infrastructure and gives scalable, low-latency multi-party media (NFR-PERF-04), while our platform retains control of **authorization, tokens, and session lifecycle** (the security-critical parts). Not persisting media by default minimizes privacy/retention risk.

---

## 7. E-Prescription Bridge to Module 5 (BRULE-38)

A doctor's e-prescription must be usable to buy medicine — it enters the **same pipeline** as an uploaded, pharmacist-verified prescription, but **pre-verified by virtue of being doctor-issued**:

- On issue, this module creates an `EPrescription` and, via `IPrescriptionPort` (Module 5), registers a **Prescription in `APPROVED` state, source = DOCTOR_ISSUED**, with mapped catalog products, quantities, refills.
- Module 5's `PrescriptionGate`, dispensing ledger, and anti-reuse controls (BRULE-12) then apply unchanged at checkout/fulfillment.
- The e-Rx is immutable; changes require a new prescription (clinical integrity).

**Design rationale.** Reusing Module 5's prescription aggregate (rather than a parallel e-Rx flow) means one gate, one dispensing ledger, one audit trail for *all* prescriptions — pharmacist-verified or doctor-issued. The only difference is the verification source, which the model already accommodates.

---

## 8. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; health artifacts envelope-encrypted; append-only/versioned where noted.

**consultation_sessions** — aggregate root.
- `id`, `appointment_id` (FK → Module 10), `doctor_id` (FK), `patient_user_id` (FK), `beneficiary_snapshot` (jsonb), `status`, `media_provider` (key), `media_room_id`, `started_at`, `ended_at`, `duration_seconds`, `is_followup_of` (nullable self-FK), `created_at`, `updated_at`.

**session_participants** — join/leave audit.
- `id`, `session_id` (FK), `user_id` (FK), `role` (DOCTOR|PATIENT|GUARDIAN), `joined_at`, `left_at`.

**consultation_notes** — versioned clinical notes.
- `id`, `session_id` (FK), `version`, `supersedes_id` (nullable), `diagnosis` (encrypted), `notes` (encrypted), `advice` (encrypted), `structured` (jsonb, encrypted), `author_doctor_id` (FK), `created_at`.

**chat_messages** — in-session chat.
- `id`, `session_id` (FK), `sender_user_id` (FK), `body` (encrypted), `attachment_ref` (encrypted storage, nullable), `sent_at`.

**e_prescriptions** — doctor-issued Rx (bridges to Module 5).
- `id`, `session_id` (FK), `doctor_id` (FK), `patient_user_id` (FK), `beneficiary_id` (FK), `prescription_id` (ref → Module 5, the registered APPROVED prescription), `items` (jsonb: product, dosage, qty, refills, instructions), `issued_at`, `is_immutable` (true).

**health_records** — unified vault index (aggregation).
- `id`, `owner_user_id` (FK), `beneficiary_id` (FK → Module 2), `record_type` (CONSULT_NOTE|E_PRESCRIPTION|DIAGNOSTIC_RESULT|APPOINTMENT|UPLOADED_DOC), `source_module`, `source_id`, `title`, `summary`, `occurred_at`, `artifact_ref` (encrypted storage, for uploads), `encryption_key_ref` (nullable), `created_at`, `deleted_at` (tombstone).
- Index (`owner_user_id`,`beneficiary_id`,`occurred_at`) for timeline.

**record_consents** — consent grants (BRULE-39).
- `id`, `owner_user_id` (FK), `beneficiary_id` (FK), `grantee_user_id` (FK, doctor/provider), `scope` (jsonb: recordTypes), `valid_from`, `valid_until`, `status` (ACTIVE|REVOKED|EXPIRED), `granted_at`, `revoked_at`.

**record_access_log** — immutable access trail (FR-REC-06, BRULE-37).
- `id`, `health_record_id` (FK, nullable), `source_ref` (for artifact-level), `actor_user_id` (FK), `actor_role`, `access_type` (VIEW|DOWNLOAD|SHARE|EXPORT), `outcome` (ALLOW|DENY), `consent_id` (nullable), `created_at`.

**data_rights_requests** — export/deletion (BRULE-40).
- `id`, `owner_user_id` (FK), `type` (EXPORT|DELETE), `status`, `scope` (jsonb), `processed_by` (nullable), `result_ref` (nullable), `created_at`, `completed_at`.

**Relationships**
- `consultation_sessions 1—N participants / notes / chat_messages / e_prescriptions`.
- `health_records N—1 beneficiary`; `health_records 1—N record_access_log`.
- `record_consents` scope grantee access to `health_records`.
- References to Modules 5 (prescription), 10 (appointment), 11 (result) by ID.

**Rationale.** `health_records` is a thin **index** (type + source reference + metadata) — the heavy artifacts live in source modules or encrypted storage. Consent + access log at this layer enforce privacy uniformly. Clinical notes and e-Rx are versioned/immutable for integrity; media is intentionally absent (not persisted).

---

## 9. API Design

Base paths: `/api/v1/consultations`, `/api/v1/records`, `/api/v1/consent`. Bearer auth; every record read passes `RecordAccessPolicy` + audit. Envelope/errors per Module 1 §14.

### 9.1 Consultation
- **POST `/consultations/{sessionId}/token`** — issue short-lived media/join token (guarded: assigned party only, BRULE-37).
- **GET `/consultations/{sessionId}`** — session detail + status (participant-scoped).
- **POST `/consultations/{sessionId}/start|end`** — doctor controls lifecycle.
- **POST `/consultations/{sessionId}/messages`** — chat message/file (encrypted).
- **POST `/consultations/{sessionId}/notes`** — doctor records/updates notes (versioned) (FR-CONS-03).
- **POST `/consultations/{sessionId}/e-prescription`** — issue e-Rx → registers APPROVED prescription in Module 5 (BRULE-38). Verified-doctor only.
- **POST `/consultations/{sessionId}/recommend-tests`** — suggest diagnostics (→ Module 11).

### 9.2 Health Records (patient)
- **GET `/records/timeline`** — unified, paginated timeline (filter by type, beneficiary) (FR-REC-01). Access-controlled.
- **GET `/records/{id}`** — record detail + pre-signed artifact URL. **Audited** (FR-REC-06).
- **POST `/records/upload`** — upload own document (encrypted) (FR-REC-02).
- **GET `/records/beneficiary/{beneficiaryId}`** — family member records (Module 2 access policy).
- **POST `/records/{id}/share`** — `{ granteeDoctorId, scope, validUntil }` → creates consent (FR-REC-04).
- **POST `/records/data-request`** — `{ type: EXPORT|DELETE, scope }` (BRULE-40).

### 9.3 Consent
- **GET `/consent`** — active grants I've given. **POST `/consent/{id}/revoke`** — revoke (BRULE-39).
- **GET `/consent/granted-to-me`** — (doctor) patients who granted me access + scope.

### 9.4 Doctor record access
- **GET `/records/patient/{patientRef}`** — (doctor) view a consented patient's records — requires active `RecordConsent`; every access audited. Errors: `RECORD_CONSENT_REQUIRED`.

**Representative errors:** `SESSION_ACCESS_DENIED` (BRULE-37), `SESSION_NOT_ACTIVE`, `DOCTOR_NOT_VERIFIED` (e-Rx, BRULE-38), `RECORD_ACCESS_DENIED`/`RECORD_CONSENT_REQUIRED` (BRULE-39, generic 403), `CONSENT_EXPIRED`, `BENEFICIARY_ACCESS_DENIED`, `DATA_REQUEST_NOT_ALLOWED` (retention/legal hold, BRULE-41), `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/consultation-records/
  domain/
    entities/            # ConsultationSession, ConsultationNote, EPrescription, ChatMessage,
    │                    # HealthRecord, RecordConsent, RecordAccessLog
    value-objects/       # SessionStatus, Participant, MediaToken, RecordType, ArtifactRef,
    │                    # ConsentScope, Diagnosis, AccessOutcome
    events/              # SessionCreated, SessionStarted, SessionEnded, NotesRecorded,
    │                    # EPrescriptionIssued, RecordAdded, ConsentGranted, ConsentRevoked, DataRequestFiled
    enums/               # SessionStatus, RecordType, ConsentStatus, DataRequestType
    repositories/        # ISessionRepository, IConsultationNoteRepository, IEPrescriptionRepository,
    │                    # IHealthRecordRepository, IConsentRepository, IAccessLogRepository
    services/            # RecordAccessPolicy (extends BeneficiaryAccessPolicy), ConsentService,
    │                    # SessionAccessPolicy, RecordTimelineComposer, RetentionPolicy
  application/
    commands/            # CreateSession, IssueMediaToken, StartSession, EndSession, PostMessage,
    │                    # RecordNotes, IssueEPrescription, UploadRecord, GrantConsent, RevokeConsent,
    │                    # FileDataRequest
    queries/             # GetSession, GetTimeline, GetRecord, GetBeneficiaryRecords,
    │                    # GetConsents, GetPatientRecordsForDoctor
    ports/               # IRealtimeMediaPort (SFU), IPrescriptionPort(5), IAppointmentPort(10),
    │                    # IDiagnosticsPort(11), IBeneficiaryAccessPort(2), IStoragePort(KMS enc),
    │                    # INotificationPort, IAuditPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/
    media/               # SfuMediaAdapter (LiveKit/Twilio) — token issue, room mgmt
    realtime/            # SignalingGateway (WS) — join/offer/answer/ICE
    storage/             # EncryptedRecordStorageAdapter (envelope enc)
    ports-adapters/      # Prescription(5)/Appointment(10)/Diagnostics(11)/Beneficiary(2)/Notification
    scheduling/          # ConsentExpirySweeper, ConsultationReminder, RetentionSweeper
    audit/
  interface/
    ws/                  # SignalingGateway (WebRTC signaling), waiting-room admit
    http/
      controllers/       # ConsultationController, HealthRecordController, ConsentController
      dtos/ guards/       # SessionAccessGuard, RecordAccessGuard(RecordAccessPolicy), PermissionsGuard
      decorators/ filters/ interceptors/  # AuditInterceptor on ALL record/session reads
    events/              # on AppointmentConfirmed(telemed)(10)→CreateSession; on ResultReady(11)/RxIssued→RecordAdded
  consultation-records.module.ts
```

**Rationale.** `RecordAccessPolicy` (extending Module 2's `BeneficiaryAccessPolicy` with consent) is the single authorization brain for all health data — every controller read passes through it + the `AuditInterceptor`. Media is a swappable `IRealtimeMediaPort` adapter (SFU provider) so the security-critical token/lifecycle logic stays in our domain. E-Rx delegates to Module 5 via `IPrescriptionPort` — one prescription pipeline.

---

## 11. Sequence Flows

### 11.1 Telemedicine Session (secure join, BRULE-37)
```
Module 10 AppointmentConfirmed(telemedicine) → CreateSession(SCHEDULED, media_room)
Patient/Doctor → POST /consultations/{id}/token
IssueMediaToken → SessionAccessPolicy: is caller assigned doctor/patient/guardian?  else SESSION_ACCESS_DENIED
IssueMediaToken → IRealtimeMediaPort: mint short-lived scoped token
→ {token, roomId}
Doctor → /start → IN_PROGRESS; participants recorded (join/leave)
... video/chat via SFU (media not persisted); chat messages encrypted+saved ...
Doctor → /end → ENDED; duration recorded; prompt notes/e-Rx
```

### 11.2 Record Notes + Issue E-Prescription (BRULE-38)
```
Doctor → POST /consultations/{id}/notes {diagnosis, notes}
RecordNotes → verified doctor + session participant → save ConsultationNote(v1, encrypted)
RecordNotes → HealthRecord add (type=CONSULT_NOTE, ref) → timeline
Doctor → POST /consultations/{id}/e-prescription {items}
IssueEPrescription → DOCTOR_NOT_VERIFIED? block (BRULE-38)
IssueEPrescription → IPrescriptionPort(5): register Prescription(APPROVED, source=DOCTOR_ISSUED, lines)
IssueEPrescription → save EPrescription(immutable, prescription_id); HealthRecord add (type=E_PRESCRIPTION)
IssueEPrescription → notify patient (FR-NOT-06); IAuditPort
→ patient can now order these meds (Module 5 gate passes)
```

### 11.3 Unified Timeline (aggregation, FR-REC-01)
```
Patient → GET /records/timeline?beneficiaryId=&type=
GetTimeline → RecordAccessPolicy.check (self or authorized beneficiary)
GetTimeline → RecordTimelineComposer: query health_records index (+ lazy-resolve summaries
              from source modules 5/10/11 via ports as needed), sort by occurred_at
GetTimeline → audit VIEW (list-level)
→ 200 [{type, title, occurredAt, sourceRef}]
```

### 11.4 Consent-based Doctor Access (BRULE-39)
```
Patient → POST /records/{id}/share {granteeDoctorId, scope, validUntil}
GrantConsent → create RecordConsent(ACTIVE, time-boxed); notify doctor
...
Doctor → GET /records/patient/{patientRef}
GetPatientRecordsForDoctor → RecordAccessPolicy: active consent covering scope? else RECORD_CONSENT_REQUIRED
 → return scoped records; audit each VIEW with consent_id
 (patient → /consent/{id}/revoke → status REVOKED → doctor access stops immediately)
```

### 11.5 Data Rights (BRULE-40/41)
```
Patient → POST /records/data-request {type: DELETE, scope}
FileDataRequest → RetentionPolicy: within retention/legal hold?
   deletable → tombstone records + withdraw access (+ purge uploads)
   retained  → DATA_REQUEST_NOT_ALLOWED for locked items; process the rest
FileDataRequest → admin review where required; IAuditPort; notify on completion
```

---

## 12. Error Handling

Reuses Module 1 §14. All privacy denials return **generic 403** without leaking existence. Key codes: `SESSION_ACCESS_DENIED`/`SESSION_NOT_ACTIVE` (BRULE-37), `DOCTOR_NOT_VERIFIED` (e-Rx, BRULE-38), `RECORD_ACCESS_DENIED`/`RECORD_CONSENT_REQUIRED`/`CONSENT_EXPIRED` (BRULE-39), `BENEFICIARY_ACCESS_DENIED` (Module 2), `DATA_REQUEST_NOT_ALLOWED` (retention/legal hold, BRULE-41), `MEDIA_TOKEN_EXPIRED`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 13. Logging & Auditing

The **strictest audit surface in the platform.** Reuses hash-chained `audit_logs` + dedicated immutable `record_access_log`. **Must-log:** session created/started/ended + participant join/leave; notes recorded (author, version); **e-prescription issued** (doctor, items) — reconciles with Module 5; **every record/artifact access** (VIEW/DOWNLOAD/SHARE/EXPORT, actor+role+outcome, consent used) — allow *and* deny (FR-REC-06, BRULE-37); consent granted/revoked/expired; data-rights requests + outcomes. Clinical content and media never in plain operational logs; media not persisted at all by default.

---

## 14. Future Scalability & Evolution

- **Media scale** — managed SFU scales horizontally; TURN/edge for regional latency; optional recording (with explicit consent + encryption) can be added behind `IRealtimeMediaPort` if regulation/patients allow.
- **Records interoperability (FHIR)** — the aggregation index + structured notes/analytes can project to **FHIR resources** for national-health-system interop later (NFR-INTEROP-03) without changing source modules.
- **AI (future)** — consult summarization, symptom triage, drug-interaction checks on e-Rx — as application services behind ports; **doctor remains clinically responsible**.
- **Consent granularity** — evolve to field-level/purpose-based consent; emergency "break-glass" access with heightened audit.
- **Retention automation** — `RetentionSweeper` enforces per-type retention (BRULE-41); legal-hold registry.
- **Extraction-ready** — the privacy/consent/audit core is a natural standalone **Health Records service**; media/signaling can be its own real-time service. All links are port/event-based.

---

## Open Questions for Product/Compliance
1. **Media provider & data residency** — which SFU (LiveKit self-host vs Twilio/Agora), and must media/signaling stay in-country for compliance?
2. **Session recording** — record consultations (with consent) for records/disputes, or never persist media (privacy-first default)?
3. **E-prescription legal validity** — regulatory requirements for a valid electronic prescription in Ethiopia (doctor e-signature, registration number on Rx)? (BRULE-38)
4. **Records retention & deletion** — exact retention per record type and what patients may delete vs what is legally retained (BRULE-40/41).
5. **Consent model** — default scope/duration for doctor access; is "break-glass" emergency access needed?
6. **FHIR/interop** — target national health data standards now or defer?

---

**End of Module 12 design.** Awaiting your approval to proceed. Recommended next module: **Notifications & Communication** — the cross-cutting multi-channel engine (push/FCM, SMS, email, in-app) with templates, preferences, and delivery tracking that every prior module depends on for FR-NOT-01..09 (BRULE-42..44).
