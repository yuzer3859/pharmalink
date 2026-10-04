# Module 5 — Prescription & Matching (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 05 — Prescription & Matching (Secure Rx upload/storage, pharmacist verification, intelligent pharmacy matching)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity/RBAC), Module 02 (Beneficiary access policy), Module 03 (Catalog classification), Module 04 (Availability engine). Consumed by: Cart/Order.
**Traceability:** FR-RX-01..09, FR-MATCH-01..07, FR-MED-10, FR-NOT-03, BRULE-01, BRULE-10, BRULE-11, BRULE-12, BRULE-14, BRULE-16, BRULE-18, BRULE-19, BRULE-21, NFR-SEC-02/10, NFR-PRIV, NFR-AUDIT

> Single source of truth for the Prescription & Matching bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module contains two closely-linked but distinct concerns, both safety- and compliance-critical:

1. **Prescription** — secure upload, encrypted storage, and **licensed-pharmacist verification** of prescriptions before any Rx medicine is dispensed (BRULE-10/11/12/14). This is the platform's clinical safety gate.
2. **Matching** — the **intelligent pharmacy matching** engine that, given a cart/order, selects the best licensed, in-stock pharmacy (or pharmacies) to fulfill it (FR-MATCH), building on Module 4's availability engine.

**Why grouped.** Both revolve around the moment an order becomes fulfillable: matching finds *who can fulfill*, prescription verification decides *whether Rx items may be fulfilled at all*. They share the order-preparation lifecycle and the same pharmacist actor, so grouping keeps that workflow cohesive. They remain separate aggregates internally (`Prescription`, `MatchRequest`) for clean responsibility.

**Primary objectives**
- Allow customers to **upload prescriptions** (image/PDF/camera) and store them **encrypted** (FR-RX-01/02/03, NFR-SEC-02).
- Route prescriptions to a **licensed pharmacist** for approve/reject with **documented reason** (FR-RX-04/05, BRULE-14).
- Enforce that **Rx items cannot be checked out/dispensed without a valid, verified prescription** (FR-MED-10, BRULE-10/11).
- Prevent **reuse/over-dispensing** of single-use prescriptions (FR-RX-09, BRULE-12).
- **Match** orders to licensed, in-stock pharmacies ranked by distance, price, rating (FR-MATCH-01/02/03), with override, re-match, and optional splitting (FR-MATCH-04/06/07, BRULE-18/19).
- **Retain** prescription records for the regulatory period (FR-RX-08, BRULE-41).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-RX-01 | Customers can upload prescriptions as image or PDF, or via camera. | FR-RX-01/02 |
| BR-RX-02 | Prescriptions are stored securely with encryption. | FR-RX-03, NFR-SEC-02 |
| BR-RX-03 | Uploaded prescriptions are routed to a licensed pharmacist for verification. | FR-RX-04, BRULE-10 |
| BR-RX-04 | Pharmacists approve or reject with a documented reason. | FR-RX-05, BRULE-14 |
| BR-RX-05 | Customers are notified of verification outcome. | FR-RX-06, FR-NOT-03 |
| BR-RX-06 | Approved prescriptions are linked to eligible order items. | FR-RX-07 |
| BR-RX-07 | A prescription must be valid, legible, and within validity period before fulfillment. | BRULE-11 |
| BR-RX-08 | Single-use prescriptions cannot be dispensed beyond prescribed quantity/refills. | FR-RX-09, BRULE-12 |
| BR-RX-09 | Rx items cannot be added to checkout without a valid prescription. | FR-MED-10, BRULE-10 |
| BR-RX-10 | Prescription records are retained for the regulatory retention period. | FR-RX-08, BRULE-41 |
| BR-MT-01 | Orders are matched only to licensed pharmacies with the items in stock. | FR-MATCH-01/05, BRULE-18 |
| BR-MT-02 | Candidate pharmacies are ranked by distance, then price and rating. | FR-MATCH-02/03 |
| BR-MT-03 | Customers may override and select a specific pharmacy. | FR-MATCH-04 |
| BR-MT-04 | If a pharmacy declines/unavailable, the order is re-matched. | FR-MATCH-06, BRULE-19 |
| BR-MT-05 | Orders may be split across pharmacies when necessary. | FR-MATCH-07 |
| BR-MT-06 | Prescription access follows beneficiary/health-record access policy + is audited. | BRULE-04, FR-REC-06 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Prescription Upload & Storage
- **F-RX-01** Upload prescription file(s): JPEG/PNG/PDF, size/type validated, malware-scanned.
- **F-RX-02** Camera capture (mobile) with client-side compression.
- **F-RX-03** Encrypted storage in Cloud Storage; DB holds only a reference + encryption key ref (envelope encryption).
- **F-RX-04** Associate prescription with the ordering customer and a **beneficiary** (Module 2) — whose Rx is it.
- **F-RX-05** Optional structured fields: prescribing doctor, hospital, issue date, validity/expiry, prescribed items (name, strength, quantity, refills).
- **F-RX-06** List/view own prescriptions and their status/history (access-controlled).

### 3.2 Verification (pharmacist workflow)
- **F-VF-01** Route uploaded prescription into a **verification queue** for a licensed pharmacist.
- **F-VF-02** Pharmacist views the image + structured data + linked order context (with audited access, BRULE-04).
- **F-VF-03** Pharmacist **approves**, mapping prescription lines to catalog products + approved quantities/refills.
- **F-VF-04** Pharmacist **rejects** with a mandatory documented reason (BRULE-14) → customer notified.
- **F-VF-05** Request clarification / re-upload (e.g., illegible) → status back to customer.
- **F-VF-06** Legibility/validity/expiry checks recorded (BRULE-11).
- **F-VF-07** Verification is tied to a specific pharmacy's pharmacist once matched (who dispenses verifies), or a platform pharmacist pre-check (policy — see §6).

### 3.3 Dispensing Control (anti-reuse)
- **F-DC-01** Track **remaining dispensable quantity/refills** per approved prescription line (BRULE-12).
- **F-DC-02** Decrement remaining on each fulfilled dispense; block when exhausted (FR-RX-09).
- **F-DC-03** Enforce validity window: expired prescription cannot be used (BRULE-11).
- **F-DC-04** Single-use marking: mark consumed after permitted dispensing.

### 3.4 Rx Gate at Checkout
- **F-GT-01** Cart/Order calls a **PrescriptionGate**: for each Rx catalog item, require a linked, approved, non-expired, non-exhausted prescription line covering the requested quantity (FR-MED-10, BRULE-10).
- **F-GT-02** OTC items pass freely; controlled/prohibited items blocked (Module 3 flag).

### 3.5 Intelligent Matching
- **F-MT-01** Given order lines + delivery location, query Module 4 availability for candidate pharmacies stocking **all** (or subsets of) items.
- **F-MT-02** Rank candidates: **distance first**, then price, then rating (configurable weights) — FR-MATCH-02/03.
- **F-MT-03** Exclude ineligible pharmacies (suspended/expired license) — FR-MATCH-05, BRULE-18.
- **F-MT-04** Customer **override**: choose a specific pharmacy from candidates (FR-MATCH-04).
- **F-MT-05** **Re-match**: if the chosen pharmacy declines or times out, offer/auto-select next best (FR-MATCH-06, BRULE-19).
- **F-MT-06** **Split matching**: when no single pharmacy has everything, propose a multi-pharmacy split (FR-MATCH-07) — configurable/optional.
- **F-MT-07** Produce a **match result** (chosen pharmacy/branch per line + reserved stock reference) consumed by Order.

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Security/Privacy** | Encrypt Rx at rest, access-controlled + audited (NFR-SEC-02/10, FR-REC-06) | Envelope encryption (KMS data keys); pre-signed short-lived URLs; `BeneficiaryAccessPolicy` (Module 2) on every view; audit each access. |
| **Safety/Compliance** | No Rx dispense without verification; no reuse (BRULE-10/11/12) | `PrescriptionGate` + dispensing ledger with remaining quantities; pharmacist-only approval. |
| **Performance** | Matching responsive under load (NFR-PERF-05) | Reuse Module 4 cached availability; ranking in-memory; async re-match via events. |
| **Reliability** | Re-match on failure without losing order (BRULE-19) | Match state machine + reservation TTL; idempotent re-match. |
| **Auditability** | Verification & dispensing fully traced (NFR-AUDIT) | Hash-chained audit + immutable dispensing ledger; who verified/approved/rejected + reason. |
| **Retention** | Regulatory retention of Rx (BRULE-41) | Retention policy on prescription store; purge respects legal hold. |
| **Scalability** | Verification queue scales | Queue partitioned by pharmacy/region; SLA timers. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Prescription** (aggregate root) — the uploaded document + metadata + verification state + lines.
- **PrescriptionLine** (entity) — one prescribed item: catalog product (post-approval), prescribed qty, refills, remaining dispensable.
- **VerificationReview** (entity) — a pharmacist's decision record (approve/reject/clarify + reason + actor + time).
- **DispenseRecord** (immutable ledger entry) — a dispensing event decrementing a line's remaining.
- **MatchRequest** (aggregate root) — a matching attempt for an order: inputs, candidates, chosen result, state.
- **MatchCandidate** (value) — a ranked pharmacy option (branch, price total, distance, rating, coverage).

### 5.2 Value Objects
- `PrescriptionStatus` (UPLOADED|PENDING_VERIFICATION|CLARIFICATION_REQUESTED|APPROVED|REJECTED|EXPIRED|CONSUMED), `ValidityPeriod` (issueDate→expiryDate), `PrescribedQuantity`, `Refills`, `RemainingDispensable`, `RejectionReason` (mandatory text/coded), `MatchStatus` (PENDING|MATCHED|OVERRIDDEN|REMATCHING|SPLIT|FAILED), `RankingWeights` (config).

### 5.3 Invariants (safety-critical)
- A prescription can only move to `APPROVED` via a **licensed pharmacist** review with lines mapped to catalog products (BRULE-10).
- A rejection **requires** a documented reason (BRULE-14) — cannot persist `REJECTED` without one.
- `RemainingDispensable(line) = approvedQuantity − Σ dispensed`; never negative; dispense blocked at zero (BRULE-12, FR-RX-09).
- A prescription past `expiryDate` is `EXPIRED` and cannot gate any checkout (BRULE-11).
- The **PrescriptionGate** allows an Rx cart line only if there exists an approved, non-expired line for the same catalog product (or approved substitute per BRULE-16) with `RemainingDispensable ≥ requestedQty`, owned by/authorized for the ordering customer+beneficiary.
- A `MatchRequest` may only choose **eligible** pharmacies (Module 4 `TransactingEligibilityPolicy`); ineligible ones are never presented (BRULE-18).
- Every dispense produces a `DispenseRecord` (append-only) and a corresponding Module 4 stock movement — the two ledgers reconcile.

**Design rationale — dispensing ledger.** Like Module 4's stock ledger, remaining-dispensable is derived from an **append-only `dispense_records`** ledger, not a mutable counter. This makes anti-reuse (BRULE-12) auditable and race-safe, and lets regulators reconstruct exactly what was dispensed against a prescription.

---

## 6. Verification Model Decision (who verifies?)

Two viable models; the design supports both via a `VerificationPolicy` config so we don't hard-code a choice:

- **Model A — Dispensing pharmacy verifies (recommended default).** After matching, the *chosen pharmacy's* licensed pharmacist verifies the prescription for that order. Pros: the dispenser owns clinical responsibility, aligns with real pharmacy practice, no central bottleneck. Cons: verification happens after match; a rejection triggers re-match/refund.
- **Model B — Platform pre-verification.** A platform pharmacist pre-approves the prescription before matching. Pros: customer gets early certainty; cleaner checkout. Cons: platform assumes clinical liability; central staffing bottleneck.

**Recommendation:** Model A for launch (liability sits with the licensed dispenser, matching real workflow), with an optional platform pre-check for high-value/diaspora orders. The state machine and APIs below accommodate either.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; soft-delete only where policy allows (prescriptions are retained, not hard-deleted — BRULE-41).

**prescriptions** — aggregate root.
- `id`, `customer_user_id` (FK), `beneficiary_id` (FK → Module 2), `status`, `file_ref` (storage key), `encryption_key_ref` (KMS), `file_type`, `doctor_name` (nullable), `hospital_name` (nullable), `issue_date` (nullable), `expiry_date` (nullable), `verified_by_user_id` (FK, nullable), `verified_at` (nullable), `verifying_pharmacy_id` (FK, nullable), `rejection_reason` (nullable), `created_at`, `updated_at`, `retention_until`.

**prescription_lines** — approved items.
- `id`, `prescription_id` (FK), `catalog_product_id` (FK → Module 3, nullable until approved), `raw_text` (as written), `prescribed_quantity`, `refills_allowed`, `dispensed_quantity` (derived cache), `remaining_dispensable` (derived cache), `is_single_use` (bool), `created_at`.

**verification_reviews** — pharmacist decisions (audit).
- `id`, `prescription_id` (FK), `reviewer_user_id` (FK), `pharmacy_id` (FK, nullable), `decision` (APPROVED|REJECTED|CLARIFICATION), `reason` (mandatory for reject), `legibility_ok` (bool), `validity_ok` (bool), `reviewed_at`.

**dispense_records** — immutable dispensing ledger (BRULE-12).
- `id`, `prescription_line_id` (FK), `order_id` (ref), `pharmacy_id` (FK), `quantity`, `dispensed_by_user_id` (FK), `stock_movement_id` (ref → Module 4), `created_at`. Append-only.

**prescription_access_log** — every view/download (FR-REC-06).
- `id`, `prescription_id` (FK), `actor_user_id` (FK), `role`, `access_type` (VIEW|DOWNLOAD), `outcome` (ALLOW|DENY), `created_at`.

**match_requests** — matching attempts.
- `id`, `order_id` (ref, nullable pre-order), `customer_user_id` (FK), `delivery_lat`, `delivery_lng`, `status`, `strategy` (SINGLE|SPLIT), `chosen_result` (jsonb: per-line pharmacy/branch/reservation), `override_pharmacy_id` (nullable), `created_at`, `updated_at`.

**match_candidates** — snapshot of ranked options (for transparency/audit).
- `id`, `match_request_id` (FK), `pharmacy_id`, `branch_id`, `coverage` (ALL|PARTIAL), `total_price`, `distance_meters`, `rating`, `rank`, `created_at`.

**Relationships**
- `prescriptions 1—N prescription_lines / verification_reviews / prescription_access_log`.
- `prescription_lines 1—N dispense_records`.
- `match_requests 1—N match_candidates`.
- References (by ID) to Module 2 beneficiary, Module 3 catalog product, Module 4 pharmacy/branch/stock_movement, Order.

**Rationale.** Prescriptions are **never hard-deleted**; `retention_until` drives lawful purge (BRULE-41). Envelope encryption (`encryption_key_ref`) keeps the sensitive image encrypted at rest with per-object data keys (NFR-SEC-02); the DB never stores the file or plaintext key.

---

## 8. Matching Algorithm (FR-MATCH)

**Inputs:** order lines (catalog product + qty), delivery GeoPoint, customer prefs, `RankingWeights` (config).

**Steps**
1. **Availability fetch** — for each line, call Module 4 `/availability/product/{id}` within service zones of the delivery point → eligible, in-stock pharmacies (already excludes suspended/expired, BRULE-18, FR-MATCH-05).
2. **Coverage grouping** — find pharmacies covering **all** lines (single-pharmacy candidates). If none and split enabled, compute a minimal multi-pharmacy cover (FR-MATCH-07).
3. **Ranking** — score each candidate: `score = w_d·norm(distance) + w_p·norm(totalPrice) + w_r·(1−norm(rating))`; **distance dominant** by default (FR-MATCH-02), price/rating secondary (FR-MATCH-03). Weights configurable (NFR-MAINT-03).
4. **Present / auto-select** — return ranked candidates; auto-pick rank #1 or let customer **override** (FR-MATCH-04).
5. **Reserve** — on selection, reserve stock via Module 4 `/availability/reserve` (per line/branch).
6. **Re-match** — if pharmacy declines or reservation/accept times out → mark `REMATCHING`, release reservations, exclude that pharmacy, select next best (FR-MATCH-06, BRULE-19). Idempotent.

**Design rationale.** Matching is **stateless computation over Module 4's availability** + a small state machine for accept/decline/re-match. Keeping the availability/stock authority in Module 4 (single source of truth) avoids duplicated stock logic and keeps matching a pure, testable ranking service. Split fulfillment is behind a config flag because it complicates delivery/settlement and may be deferred (open question).

---

## 9. API Design

Base paths: `/api/v1/prescriptions`, `/api/v1/pharmacy/verification`, `/api/v1/matching`. Bearer auth; access via `BeneficiaryAccessPolicy` for prescription reads. Envelope/errors per Module 1 §14.

### 9.1 Prescriptions (customer)
- **POST `/prescriptions`** — multipart upload (+ beneficiaryId, optional metadata). Malware-scanned, encrypted. → 201 `{ prescriptionId, status: UPLOADED }`.
- **GET `/prescriptions`** — list own (access-controlled).
- **GET `/prescriptions/{id}`** — detail + pre-signed short-lived file URL. **Audited** (FR-REC-06).
- **POST `/prescriptions/{id}/reupload`** — respond to clarification request.
- **DELETE `/prescriptions/{id}`** — soft (retention-respecting) removal request.

### 9.2 Verification (pharmacist — `prescription:verify`)
- **GET `/pharmacy/verification/queue`** — pending prescriptions (scoped to pharmacy / region). Paginated, SLA-sorted.
- **GET `/pharmacy/verification/{id}`** — view prescription + order context. **Audited access.**
- **POST `/pharmacy/verification/{id}/approve`** — Body `{ lines: [{ rawText, catalogProductId, approvedQuantity, refills, singleUse }], legibilityOk, validityOk }`. → 200. Emits `PrescriptionApproved`.
- **POST `/pharmacy/verification/{id}/reject`** — Body `{ reason }` (mandatory, BRULE-14). → 200. Emits `PrescriptionRejected` → notify customer.
- **POST `/pharmacy/verification/{id}/clarify`** — Body `{ message }` → status CLARIFICATION_REQUESTED.

### 9.3 Prescription Gate (internal — called by Cart/Order)
- **POST `/prescriptions/gate/check`** — Body `{ customerUserId, beneficiaryId, items:[{catalogProductId, quantity}] }` → `{ allowed: bool, blocked:[{productId, reason}], usablePrescriptionLineIds }`. Enforces FR-MED-10, BRULE-10/11/12.

### 9.4 Dispensing (internal — called by Order fulfillment)
- **POST `/prescriptions/dispense`** — Body `{ prescriptionLineId, orderId, pharmacyId, quantity, stockMovementId }` → decrements remaining; writes `DispenseRecord`. Blocks if exhausted/expired.

### 9.5 Matching
- **POST `/matching/find`** — Body `{ orderLines, deliveryLat, deliveryLng, allowSplit? }` → ranked `match_candidates`.
- **POST `/matching/{requestId}/select`** — Body `{ pharmacyId | override }` → reserve stock, return chosen result.
- **POST `/matching/{requestId}/rematch`** — exclude current, pick next best (BRULE-19).
- **GET `/matching/{requestId}`** — status + chosen result.

**Representative errors:** `PRESCRIPTION_NOT_FOUND, PRESCRIPTION_EXPIRED, PRESCRIPTION_NOT_APPROVED, PRESCRIPTION_EXHAUSTED, RX_REQUIRED (gate block), REJECTION_REASON_REQUIRED, VERIFICATION_FORBIDDEN, NO_PHARMACY_MATCH, MATCH_CANDIDATE_UNAVAILABLE, RESERVATION_EXPIRED, RBAC_FORBIDDEN, VALIDATION_ERROR, FILE_TYPE_UNSUPPORTED, FILE_SCAN_FAILED`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/prescription-matching/
  domain/
    entities/            # Prescription, PrescriptionLine, VerificationReview, DispenseRecord,
    │                    # MatchRequest, MatchCandidate
    value-objects/       # PrescriptionStatus, ValidityPeriod, RemainingDispensable, RejectionReason,
    │                    # MatchStatus, RankingWeights, PrescribedQuantity
    events/              # PrescriptionUploaded, PrescriptionApproved, PrescriptionRejected,
    │                    # ClarificationRequested, MedicineDispensed, OrderMatched, RematchTriggered, MatchFailed
    enums/               # PrescriptionStatus, VerificationDecision, MatchStatus, MatchStrategy
    repositories/        # IPrescriptionRepository, IVerificationRepository, IDispenseLedgerRepository,
    │                    # IMatchRepository
    services/            # PrescriptionGate, DispensingPolicy (anti-reuse), MatchingEngine, RankingStrategy, VerificationPolicy
  application/
    commands/            # UploadPrescription, ApprovePrescription, RejectPrescription, RequestClarification,
    │                    # DispenseMedicine, FindMatch, SelectMatch, Rematch
    queries/             # GetPrescription, ListPrescriptions, GetVerificationQueue, GetMatchResult, CheckRxGate
    ports/               # IStoragePort (encrypted files), IMalwareScanPort, IKmsPort, IAvailabilityPort (Module 4),
    │                    # ICatalogPort (classification/equivalence), IBeneficiaryAccessPort (Module 2),
    │                    # INotificationPort, IAuditPort, ICachePort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/
    storage/             # EncryptedCloudStorageAdapter (envelope enc via KMS)
    scanning/            # MalwareScanAdapter
    availability/        # AvailabilityPortAdapter (Module 4)
    catalog/ beneficiary/ notification/ audit/ cache/   # port adapters
    scheduling/          # VerificationSlaTimer, MatchTimeoutSweeper (re-match on timeout)
  interface/
    http/
      controllers/       # PrescriptionController, VerificationController, PrescriptionGateController, MatchingController
      dtos/ guards/       # PrescriptionAccessGuard (uses IBeneficiaryAccessPort), PermissionsGuard
      decorators/ filters/ interceptors/  # AuditInterceptor on all prescription reads
    events/              # on PrescriptionRejected → notify + trigger order re-match/refund hook
  prescription-matching.module.ts
```

**Rationale.** `PrescriptionGate`, `DispensingPolicy`, and `MatchingEngine` are pure domain services (framework-free, unit-testable) — the compliance and safety logic has one clear home. All cross-module data (availability, catalog, beneficiary access) is reached through ports, never tables.

---

## 11. Sequence Flows

### 11.1 Upload → Verify (Model A: dispensing pharmacy)
```
Customer → POST /prescriptions (file, beneficiaryId)
UploadPrescription → IMalwareScanPort.scan  [FILE_SCAN_FAILED]
UploadPrescription → IKmsPort: data key; IStoragePort: store encrypted; save Prescription(UPLOADED)
UploadPrescription → IAuditPort: PRESCRIPTION_UPLOADED → 201
... customer builds cart with Rx items, matching runs, pharmacy chosen ...
Order → prescription enters chosen pharmacy's verification queue (PENDING_VERIFICATION)
Pharmacist → GET /pharmacy/verification/{id}  → IBeneficiaryAccessPort.check + audit VIEW
Pharmacist → POST .../approve {lines mapped to catalogProductIds, qty, refills}
ApprovePrescription → set APPROVED; create lines with remaining=approvedQty
ApprovePrescription → emit PrescriptionApproved → notify customer (FR-NOT-03) → order proceeds
```

### 11.2 Reject (documented reason, BRULE-14)
```
Pharmacist → POST /pharmacy/verification/{id}/reject {reason}
RejectPrescription → reason present? else 422 REJECTION_REASON_REQUIRED
RejectPrescription → status REJECTED; VerificationReview saved
RejectPrescription → emit PrescriptionRejected → notify customer; Order cancels Rx line / refund + re-match remainder
RejectPrescription → IAuditPort: PRESCRIPTION_REJECTED {reviewer, reason}
```

### 11.3 Rx Gate at Checkout (FR-MED-10, BRULE-10/11/12)
```
Order → POST /prescriptions/gate/check {customer, beneficiary, items}
CheckRxGate → for each item: ICatalogPort.getProduct → Rx?
  Rx → find approved, non-expired line (same product or approved substitute) with remaining ≥ qty
       none → blocked += {product, RX_REQUIRED | PRESCRIPTION_EXPIRED | PRESCRIPTION_EXHAUSTED}
  OTC → allow
CheckRxGate → allowed = blocked.empty → {allowed, blocked, usableLineIds}
```

### 11.4 Match → Select → Reserve → Re-match
```
Order → POST /matching/find {lines, lat, lng}
FindMatch → IAvailabilityPort per line (Module 4) → candidates (eligible only)
FindMatch → RankingStrategy: distance→price→rating → ranked list; save MatchRequest(PENDING)
→ candidates
Customer/Auto → POST /matching/{id}/select {pharmacyId?}
SelectMatch → IAvailabilityPort.reserve per line/branch  → chosen_result; status MATCHED
... chosen pharmacy declines / MatchTimeoutSweeper fires ...
Rematch → release reservations; exclude pharmacy; pick next best (BRULE-19); status REMATCHING→MATCHED
 none left → status FAILED → NO_PHARMACY_MATCH → notify + refund/hold
```

### 11.5 Dispense (anti-reuse, BRULE-12)
```
Order fulfillment → POST /prescriptions/dispense {lineId, orderId, pharmacyId, qty, stockMovementId}
DispenseMedicine → DispensingPolicy: remaining ≥ qty AND not expired
  fail → 409 PRESCRIPTION_EXHAUSTED / PRESCRIPTION_EXPIRED
DispenseMedicine → append DispenseRecord; recompute remaining; if 0 & single-use → status CONSUMED
DispenseMedicine → IAuditPort: MEDICINE_DISPENSED
```

---

## 12. Error Handling

Reuses Module 1 §14. Safety/compliance errors are hard blocks. Notable: `RX_REQUIRED` (checkout blocked, FR-MED-10), `PRESCRIPTION_EXPIRED`/`PRESCRIPTION_EXHAUSTED` (BRULE-11/12), `REJECTION_REASON_REQUIRED` (BRULE-14), `NO_PHARMACY_MATCH` (triggers customer choice/refund), `FILE_TYPE_UNSUPPORTED`/`FILE_SCAN_FAILED` (upload safety). Access denials on prescriptions return generic 403 without leaking existence.

---

## 13. Logging & Auditing

Reuses hash-chained `audit_logs`; plus dedicated `prescription_access_log` and immutable `dispense_records`. **Must-log:**
- Prescription uploaded, viewed/downloaded (actor+role, FR-REC-06), re-uploaded.
- Verification approved/rejected/clarify (reviewer, pharmacy, **reason** on reject).
- Every dispense (line, order, qty, pharmacist) — reconciles with Module 4 stock movement.
- Match found (candidates snapshot), selected/override, re-match, match failed.
- Gate decisions that block Rx checkout (for compliance analytics).

Operational logs never contain prescription image contents or personal medical text.

---

## 14. Future Scalability & Evolution

- **Verification queue scaling** — partition by pharmacy/region; SLA timers + escalation; workload balancing across pharmacists.
- **Matching at scale** — reuse Module 4 cached geo-availability; move ranking to a dedicated worker; precompute candidate sets for popular products per geo-cell.
- **AI-assisted verification (future)** — OCR to auto-extract prescription lines and pre-fill pharmacist review; anomaly/forgery detection — added as application services behind ports; **pharmacist remains the approver** (safety/liability).
- **Substitution intelligence** — leverage Module 3 equivalence groups so the gate can accept an approved substitute (BRULE-16) with pharmacist consent flow.
- **Split-fulfillment maturity** — enable multi-pharmacy split once delivery/settlement support it (FR-MATCH-07).
- **Extraction-ready** — depends on Modules 2/3/4 via ports and emits domain events; can split into separate Prescription and Matching services (Matching is stateless-friendly for horizontal scale).

---

## Open Questions for Product/Compliance
1. **Verification model** — confirm Model A (dispensing pharmacy verifies) as default vs platform pre-verification (see §6).
2. **Prescription validity period** — default expiry when the prescription doesn't state one (regulatory default in Ethiopia?).
3. **Substitute dispensing** — may an approved prescription be filled with a generic-equivalent (BRULE-16) automatically, or always require explicit pharmacist/customer consent?
4. **Split fulfillment at launch** — enable FR-MATCH-07 now or defer?
5. **Retention period** — exact regulatory retention for prescriptions and dispensing records (drives `retention_until`).

---

**End of Module 5 design.** Awaiting your approval to proceed. Recommended next module: **Cart, Checkout & Orders** — the order state machine (placed→verified→accepted→dispatched→delivered→completed/cancelled), integrating the Rx gate, matching result, stock reservation, and payment authorization (FR-ORD, BRULE-17/20).
