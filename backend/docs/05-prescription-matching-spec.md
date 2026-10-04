# Module 05 — Prescription & Matching: Vertical Slice 1 Implementation Specification

**Slice:** Prescription Upload/Storage + Pharmacist Verification + Anti-Reuse Dispensing Ledger + Rx Checkout Gate + Availability-Based Pharmacy Matching
**Status:** **DRAFT — NOT READY FOR IMPLEMENTATION.** Architecture review completed (this revision resolves all 12 originally-open questions from §20 v1 with concrete decisions — see §20 v2). Implementation remains blocked on exactly **two required prerequisite schema changes** (§6.2/§6.6) and **one required shared-code addition** (§15.1, appending to `shared/errors/error-codes.ts` — the same "append per Phase-0 freeze exception" step every prior module took). No `backend/src` or `backend/test` files were created or modified while preparing this document; `backend/prisma/schema/` was **not** modified (schema changes below remain proposed, not applied) — see the Final Report appended after §20 for the full sign-off checklist.
**Parent design doc:** `architecture/module-05-prescription-matching.md` (§1–14) — this document narrows that design into a buildable, end-to-end first slice per `architecture/00-implementation-roadmap.md` §1 ("vertical slices, not horizontal layers"), following the same gate Modules 02/03/04 went through (`backend/docs/02-profiles-spec.md`, `03-catalog-spec.md`, `04-pharmacy-inventory-spec.md`).
**Depends on:** Module 01 — Identity (RBAC, guards, audit, error envelope, `organizations`/`verification_requests`/`user_roles`, reused as-is). Module 02 — Profiles (`CustomerProfile`, planned `Beneficiary` — **not yet implemented**, see §2.2). Module 03 — Catalog, Slice 1 (`ICatalogPort.getProduct()` — read-only, implemented). Module 04 — Pharmacy & Inventory, Slice 1 (`IInventoryPort` reserve/confirm/release/dispatch, `GET /availability/product/:id` — implemented). **Consumed by (future):** Module 06 (Orders — Rx gate + matching + dispensing at checkout/fulfillment time), Module 12 (Consultation/Records — `EPrescriptionIssued` registers an `APPROVED` prescription into this module), Module 16 (Admin — compliance oversight).
**Traceability:** FR-RX-01..09, FR-MATCH-01..07, FR-MED-10, FR-NOT-03, BRULE-01, BRULE-10, BRULE-11, BRULE-12, BRULE-14, BRULE-16, BRULE-18, BRULE-19, BRULE-21, NFR-SEC-02/10, NFR-PRIV, NFR-AUDIT.

> Prepared per user instruction: **design/specification only.** Every "required migration" / "new permission" / "new enum value" item below is a *proposed* change for a future implementation PR — normal for a pre-build spec, same as Modules 02/03/04's own migration/permission sections. Architectural open questions are called out explicitly in §20 rather than silently assumed.

---

## 0. Why this is a separate slice from the parent design doc, and why it ships now

`architecture/module-05-prescription-matching.md` specifies the **full** Prescription & Matching bounded context, including AI-assisted OCR pre-fill (§14, future), full split-fulfillment across pharmacies (FR-MATCH-07), and a platform-pre-verification model (Model B, §6). Per the roadmap's "vertical slices, not horizontal layers" principle, **Slice 1 ships the smallest end-to-end capability that unblocks Module 06 (Orders)**, which the roadmap (`00-implementation-roadmap.md` §3, Phase 1) sequences directly after this module: `03 Catalog → 04 Pharmacy/Inventory → 05 Prescription/Matching → 06 Orders → 07 Payment → 08 Delivery`.

### 0.1 In scope for Slice 1
- **Prescription upload & storage** — customer submits a prescription as an **already-uploaded storage reference** (`fileRef`), not a multipart upload handled by this module (see §2.3 for why — this is a real, load-bearing constraint, not an oversight).
- **Verification workflow** — route to a pharmacist verification queue; approve (with lines mapped to catalog products + approved quantity/refills) or reject (mandatory reason, BRULE-14); clarification request.
- **Anti-reuse dispensing ledger** — append-only `dispense_records`, `remainingDispensable` derived and never negative (BRULE-12).
- **Rx checkout gate** — `PrescriptionGate` service + internal port method, consumed by Module 06 in the future (FR-MED-10, BRULE-10/11).
- **Matching engine (single-pharmacy only for Slice 1)** — rank Module 04 availability candidates by distance then price; customer override; re-match on decline/timeout (FR-MATCH-01..06, BRULE-18/19). **Split fulfillment (FR-MATCH-07) is explicitly deferred** — see §0.2.
- **Prescription access logging** — every view/download audited (FR-REC-06).
- Permissions, audit events, outbox events, error codes, and DTO validation for all of the above.

### 0.2 Explicitly out of scope for this slice (tracked for later slices of Module 05)
| Deferred item | Why deferred | Covered by |
| --- | --- | --- |
| Real file upload + malware scan + KMS (`IStoragePort`, `IMalwareScanPort`, `IKmsPort`) | **No module in this codebase has built these yet** (confirmed by search — Module 01's `VerificationRequest.documents[].storageRef` already assumes a pre-uploaded, opaque reference, and Module 02/03's `logoUrl`/photo fields are explicitly deferred for the identical reason: "requires a new `IStoragePort`/cloud-storage adapter"). Module 05 Slice 1 **follows the exact same established convention** rather than being the first module to build storage infra as a side effect of an unrelated slice. See §2.3. | Module 05 — Slice 2 (candidate to also unblock Module 02 Slice 2 photo upload and Module 11 diagnostics results, if a shared `shared/storage/` port is built once, per §20 Q1) |
| Beneficiary-scoped access (`BeneficiaryAccessPolicy`) | **Module 02 has not implemented `Beneficiary` yet** — `backend/docs/02-profiles-spec.md` §1.2 explicitly defers it to "Module 02 — Slice 2" (beneficiaries) and "Slice 4" (`BeneficiaryAccessPolicy` itself). Module 05 cannot depend on a policy that does not exist. See §2.2 for the Slice-1-scoped substitute. | Module 05 — Slice 2, coordinated with Module 02 Slice 2/4 |
| Substitute dispensing via `EquivalenceGroup` (BRULE-16) | `EquivalenceGroup`/`Product.equivalenceGroupId` schema exists but Module 03 defers the substitution *feature* (moderation-reviewed, safety-critical) to "Module 03 — Slice 2" (`backend/docs/03-catalog-spec.md` §0.2). The Rx gate cannot honor an approved-substitute rule against a feature that isn't built. | Module 05 — Slice 2, coordinated with Module 03 Slice 2 |
| Split multi-pharmacy fulfillment (FR-MATCH-07) | Product/architecture decision explicitly left open by the parent doc (§14.4) and by Module 04's own spec (§14.2, "not blocking for Module 04... remains open at the index level"). Module 04's availability API is already split-friendly (per-listing results), so nothing here blocks adding it later without a Module 04 change. | Module 05 — Slice 2, once Module 06 decides split-fulfillment/settlement policy |
| Rating in match ranking (FR-MATCH-03's "then rating") | **Module 15 (Reviews) does not exist** (Phase 3 in the roadmap, far after this module's Phase 1 slot) — there is no `ratingAvg` data flowing into `GET /availability/product/:id`'s response shape (checked: `AvailabilityItem` has no rating field). Ranking in Slice 1 is **distance → price only**; a rating term is added once Module 15 exists and can populate it, with no ranking-algorithm shape change (just a new weighted term). | Module 05 — Slice 2, after Module 15 |
| AI-assisted OCR pre-fill of prescription lines | Explicitly future work in the parent doc §14 ("pharmacist remains the approver"). No safety dependency on it for Slice 1. | Module 05 — Slice 2+ |
| Verification SLA timers / escalation, queue partitioning by region | Operational scaling concern (parent doc §14); Slice 1's queue is a simple `WHERE status=PENDING_VERIFICATION AND verifyingPharmacyId = ?` paginated list — correct at MVP scale. | Module 05 — Slice 2 |
| Platform pre-verification (Model B, §6 of parent doc) | Model A (dispensing pharmacy verifies) is confirmed as the Slice 1 default — see §4. Model B needs a distinct "platform pharmacist" staffing/queue concept not needed yet. | Module 05 — Slice 2 (config-gated) |

### 0.3 Definition of done for this slice
A customer can upload a prescription (via a pre-obtained storage reference) linked to themselves (not yet to a beneficiary — see §2.2), have it enter a pharmacy's verification queue once a pharmacy is associated with the order flow, have a `PHARMACIST`-role staff member at that pharmacy approve (mapping lines to catalog products with approved quantities/refills) or reject (with a mandatory reason), have Rx checkout blocked until an approved, non-expired, non-exhausted line exists for the requested product and quantity, have every dispense against that line ledgered and blocked once exhausted, and have an order's cart lines matched to ranked, eligible, in-stock Module 04 pharmacies with override and re-match support — all through permission-guarded (for writes), audited, envelope-consistent, transactionally-atomic endpoints, backed by tests per `00-implementation-roadmap.md` §5, matching the hardening pattern established in Modules 02/03/04.

---

## 1. Business & Functional Requirements Covered

| ID | Requirement | Slice 1 coverage |
| --- | --- | --- |
| BR-RX-01 | Upload prescriptions (image/PDF/camera) | ✅ via pre-uploaded `fileRef` (§2.3) — the module accepts a reference, not raw bytes |
| BR-RX-02 | Stored securely, encrypted | ✅ `encryptionKeyRef` column preserved; **actual encryption is the uploader's responsibility in Slice 1** (§2.3, §14) — flagged, not silently assumed |
| BR-RX-03 | Routed to a licensed pharmacist for verification | ✅ verification queue scoped to `verifyingPharmacyId`; "licensed" = `PHARMACIST` role at that org (§4, gap noted in §20 Q3) |
| BR-RX-04 | Pharmacist approves/rejects with documented reason | ✅ `ApprovePrescriptionCommand` / `RejectPrescriptionCommand` |
| BR-RX-05 | Customer notified of outcome | ✅ via `INotificationPort` (Module 13) on `PrescriptionApproved`/`PrescriptionRejected` |
| BR-RX-06 | Approved prescriptions linked to eligible order items | ✅ `PrescriptionGate` |
| BR-RX-07 | Valid, legible, non-expired before fulfillment | ✅ `legibilityOk`/`validityOk` recorded at approval; expiry checked at gate + dispense time |
| BR-RX-08 | Single-use / refill limits enforced | ✅ `remainingDispensable` ledger (BRULE-12) |
| BR-RX-09 | Rx items blocked at checkout without valid prescription | ✅ `CheckRxGateQuery` (internal port method, consumed by Module 06 later) |
| BR-RX-10 | Regulatory retention | ✅ `retentionUntil` column preserved; default retention period is an **open product question** (§20 Q2) |
| BR-MT-01 | Match only licensed, in-stock pharmacies | ✅ delegates eligibility to Module 04's `TransactingEligibilityPolicy` via `GET /availability/product/:id` (already excludes ineligible pharmacies) |
| BR-MT-02 | Rank by distance, then price, then rating | ✅ distance → price; **rating term deferred** (§0.2) |
| BR-MT-03 | Customer override | ✅ `SelectMatchCommand` accepts an explicit `pharmacyId` |
| BR-MT-04 | Re-match on decline/unavailable | ✅ `RematchCommand` |
| BR-MT-05 | Split fulfillment | ⏸ Deferred (§0.2) |
| BR-MT-06 | Prescription access follows beneficiary/health-record access policy, audited | ⚠️ **Partially covered** — audited fully (✅); beneficiary-scoped access policy itself is deferred to match Module 02's own timeline (§2.2) |

---

## 2. Integration with Modules 01 (Identity), 02 (Profiles), 03 (Catalog), 04 (Pharmacy/Inventory)

### 2.1 No cross-module table reads or Prisma relations (ADR-002)
`Prescription.customerUserId`, `.beneficiaryId`, `.verifiedByUserId`, `.verifyingPharmacyId`; `PrescriptionLine.catalogProductId`; `DispenseRecord.orderId`, `.pharmacyId`, `.stockMovementId`; `MatchRequest.orderId`, `.customerUserId`; `MatchCandidate.pharmacyId`, `.branchId` — all already plain `String` columns in `prisma/schema/05-prescription.prisma`, no Prisma relations across contexts. This module reads three other bounded contexts (the most of any module built so far), all through ports:

- **`IIdentityPort`** (new, own copy per ADR-002 — not imported from Module 04) — `getUserOrganizationIds(userId): Promise<string[]>` and `hasRoleAtOrganization(userId, organizationId, roleKey): Promise<boolean>` (new method, needed to confirm "is this user a `PHARMACIST` at the pharmacy that is verifying/dispensing" — mirrors Module 04's own precedent of extending its `IIdentityPort` copy beyond the two methods literally named in its parent doc, e.g. `getUserOrganizationIds`). Backed by a direct `PrismaService` read of `user_roles`/`roles`, same in-process/port-abstracted pattern as Module 04 §2.
- **`ICatalogPort`** (own copy, reused shape from Module 04's `CatalogProductView`) — `getProduct(productId)`, used by `ApprovePrescriptionCommand` (validate mapped product exists/is `ACTIVE`) and `CheckRxGateCommand` (is this product Rx-classified?).
- **`IAvailabilityPort`** (new — Module 05 is the **first consumer** of Module 04's `IInventoryPort`/availability query) — two methods: `getAvailability(catalogProductId, geo?): Promise<AvailabilityCandidate[]>` (adapts `GET /availability/product/:id`'s response, called in-process the same way Module 04 itself calls `ICatalogPort`/`IIdentityPort` — a direct Nest DI injection of Module 04's exported `GetAvailabilityQuery`, not an HTTP round-trip, per the same reasoning as Module 04 §10.3) and `reserve/release` delegating straight through to Module 04's already-exported `IInventoryPort` (Module 05 does **not** wrap reserve/release in its own port — it imports `PharmacyInventoryModule` and injects `IInventoryPort` directly, since re-wrapping an already-clean port in another port adds a layer with no behavioral difference; Module 05 only adds its own `IAvailabilityPort` for the **read** side because the shape needed for ranking (candidate list) is genuinely different from the raw `AvailabilityItem[]`).
- **`IBeneficiaryAccessPort`** — **NOT implemented in Slice 1.** See §2.2.
- **`INotificationPort`** (Module 13) — already the established pattern (`00-shared-conventions.md` §15); used for `PrescriptionApproved`/`PrescriptionRejected`/match-failed notifications. Module 13 is Phase 0 and already exists per the roadmap, so this is a real dependency, not deferred.

### 2.1.1 [RESOLVED, review finding] Transaction isolation — Module 05 follows Modules 02/03, NOT Module 04
A close read of the actual shared audit implementation (`shared/audit/audit.service.ts`) surfaced a real, code-verified cross-module inconsistency that this spec must not blindly copy from the wrong precedent. `AuditService.record(params, tx)` reads the current hash-chain tail and inserts a new entry bound to it; its own doc comment states that when a caller supplies `tx`, "preserving the 'no fork' guarantee... becomes the CALLER's responsibility." Modules 02 (Profiles) and 03 (Catalog) both independently run **every** mutation transaction that co-locates state + audit + outbox at **`Serializable`** isolation with a bounded retry (`TRANSACTION_RETRY_MAX_ATTEMPTS = 5`, catching Postgres codes `P2034`/`40001`/`40P01` — see `modules/catalog/application/support/dedup-conflict.ts`). **Module 04 does not** — its `PrismaUnitOfWork` runs at `Read Committed` (correct for its own row-locked stock-quantity concern) but its commands still call `this.audit.record(..., tx)` inside that same `Read Committed` transaction (confirmed in ≥10 commands, e.g. `add-batch.command.ts`, `adjust-batch.command.ts`, `activate-pharmacy.command.ts`) — which, per `AuditService`'s own documented risk, can silently fork the hash chain under true concurrent writers, since row-locking `inventory_listings` does nothing to serialize concurrent inserts into the separate, unlocked `audit_logs` table. This has now been formalized as **ADR-013** (`architecture/00-decision-log.md`) and flagged there as a pre-existing gap in already-shipped Module 04 code — **out of scope for this review to fix** (Module 04 is frozen/QA-verified and this document must not modify its production code), but explicitly not something Module 05 may copy.
**Decision for Module 05 (binding on §8/§12 below):** every Module 05 mutation command that writes state + an `AuditService.record(..., tx)` call + an outbox event in one transaction **must** run that transaction at `Serializable` isolation with the same bounded-retry wrapper pattern as Module 03's `runWithDedupRetry` (own copy, e.g. `runWithMatchRetry`/`isRetryableTransactionConflict`, per ADR-002's "own copy per module" discipline — not a literal import of Catalog's file). This applies to `UploadPrescriptionCommand`, `ApprovePrescriptionCommand`, `RejectPrescriptionCommand`, `RequestClarificationCommand`, `DispenseMedicineCommand`, `FindMatchCommand`, `SelectMatchCommand`, and `RematchCommand`. Row-level locking (`SELECT ... FOR UPDATE`) is **not** needed in addition — Postgres's `Serializable` isolation itself detects the write-skew that would otherwise let two concurrent dispenses both read the same `remainingDispensable` (this is a stronger guarantee than Module 04's `FOR UPDATE`+`Read Committed` combination, not a weaker one, and it is also what the ledger-adjacent, audit-carrying nature of `dispense_records` actually needs). Categorization: **documentation decision, backed by a new ADR (ADR-013)** — no prerequisite code change to Module 04, no blocker for Module 05.

### 2.2 The `BeneficiaryAccessPolicy` gap — Slice 1's resolution
The parent design doc (§5.1, F-RX-04) assumes prescriptions are associated with a **beneficiary** (Module 02) and gated by `BeneficiaryAccessPolicy` (BRULE-04, `00-shared-conventions.md` §3). **This does not exist yet**: `backend/docs/02-profiles-spec.md` §1.2 defers `Beneficiary`/`Guardianship` to "Module 02 — Slice 2" and `BeneficiaryAccessPolicy` itself to "Module 02 — Slice 4 (post Phase 1)" — i.e. **after** this module's own roadmap slot. Building against a policy that doesn't exist would either block Module 05 entirely or require guessing its future shape.

**Resolution for Slice 1:** the schema's `beneficiaryId` column is **retained but treated as an opaque, unenforced, nullable scalar** — the client may pass it (for future-proofing / UI grouping only), but Slice 1's access control is **owner-only**: a prescription is visible/actionable only to `customerUserId` (the uploader) plus staff with `prescription:verify` at the `verifyingPharmacyId` org, plus admin. No beneficiary-delegated access (e.g. a parent viewing a child's prescription) is possible in Slice 1. This is the same "ship the narrower, correct-today policy, widen later" approach Module 04 took with `TransactingEligibilityPolicy` needing no beneficiary concept at all. **When Module 02 Slice 2/4 lands, Module 05 gains a `BeneficiaryAccessPolicy` check as an additive change** (widens who can access, never narrows) — resolved as §20 Decision 4, not silently built around.

### 2.3 The "no upload infrastructure exists" constraint — Slice 1's resolution
The parent doc's F-RX-01/02/03 describe multipart file upload, camera capture, and encrypted cloud storage with malware scanning, requiring `IStoragePort`, `IMalwareScanPort`, and `IKmsPort`. **A search of the entire codebase confirms none of these exist anywhere** — not in Module 01 (whose own `VerificationRequest.documents[].storageRef` is explicitly documented as "an opaque reference into encrypted object storage — never the document bytes themselves", i.e. Identity never implemented upload either), not in Module 02 (`photoUrl`/`logoUrl` fields explicitly deferred "requires a new `IStoragePort`/cloud-storage adapter — a separate infra concern"), not in Module 03 or 04 (same `logoUrl`-is-already-hosted-URL-only pattern).

**Resolution for Slice 1:** `POST /prescriptions` accepts `{ fileRef: string, encryptionKeyRef?: string, fileType: string, beneficiaryId?, doctorName?, hospitalName?, issueDate?, expiryDate? }` — the **client** (mobile/web) is responsible for uploading to and encrypting via an external object store *before* calling this endpoint, exactly mirroring Module 01's existing `VerificationDocument` convention. This is the established, precedent-backed convention for this codebase, not an invented shortcut — **Module 05 does not become the first module to build cloud storage infrastructure as an incidental side effect of this slice.** `IStoragePort`/`IMalwareScanPort`/`IKmsPort` remain named in the folder layout (§11) as the future extension point, with `shared/crypto`'s existing `CryptoService`/`IEncryptionPort` (envelope encryption already built for Phase 0, ADR-009) available to wrap `encryptionKeyRef` server-side once a real upload path exists. **Resolved as §20 Decision 1** — accepted as a documentation-only decision for Slice 1, with a non-blocking recommendation for a future shared storage port, since this is a genuine, cross-module gap (Module 02's photo upload and Module 11's diagnostic results will hit the identical wall) worth solving once, centrally, rather than three more times.

---

## 3. Domain Model

### 3.1 Prescription (aggregate root)
Existing Prisma model (`prisma/schema/05-prescription.prisma`) reused as-is (no schema changes required for this entity — see §6.1).

| Field | Type | Nullable | Notes |
| --- | --- | --- | --- |
| `id` | UUID | no | PK |
| `customerUserId` | String (cross-module scalar) | no | Owner; validated against the calling `AuthenticatedPrincipal` |
| `beneficiaryId` | String (cross-module scalar) | yes | **Opaque, unenforced in Slice 1** (§2.2) |
| `status` | `PrescriptionStatus` | no, default `UPLOADED` | See §3.11 state machine |
| `fileRef` / `encryptionKeyRef` / `fileType` | String | yes | Client-supplied, opaque (§2.3) |
| `doctorName` / `hospitalName` / `issueDate` / `expiryDate` | — | yes | Optional structured metadata (F-RX-05) |
| `verifiedByUserId` / `verifiedAt` / `verifyingPharmacyId` | — | yes | Set on approve/reject |
| `rejectionReason` | String | yes | **Mandatory at the command layer when status → REJECTED** (BRULE-14), nullable in schema because it's absent for every other status |
| `retentionUntil` | DateTime | yes | Set at create time = `now + retentionYears` (config, §20 Q2); drives future purge job (not built in Slice 1 — no purge job exists yet for any module) |

### 3.2 PrescriptionLine (entity)
Existing model reused as-is. `catalogProductId` is **null until approval** (raw, unmapped text before then); `remainingDispensable` is a **derived cache**, recomputed transactionally from `dispense_records` on every dispense (never independently settable), mirroring Module 04's `sellable` cache pattern (ADR-006).

### 3.3 VerificationReview (entity, append-style — one row per decision)
Existing model reused as-is. A `Prescription` may accumulate multiple `VerificationReview` rows over its lifetime (e.g. `CLARIFICATION` → re-upload → `APPROVED`), each immutable once written — mirrors the audit-trail intent of `00-shared-conventions.md` §4's "verification decisions" must-audit item.

### 3.4 DispenseRecord (immutable ledger entry)
Existing model reused as-is. **Append-only — no update/delete path is ever exposed**, identical discipline to Module 04's `StockMovement` (ADR-006). One subtlety not yet in the schema: see §6.2 for a proposed uniqueness constraint closing a replay hole.

### 3.5 PrescriptionAccessLog (entity)
Existing model reused as-is. Written on **every** `GET /prescriptions/:id` (allow *and* deny outcomes — `00-shared-conventions.md` §3 "logged" applies to denials too), independent of the hash-chained `audit_logs` (this is Module 05's own fine-grained access trail, analogous to how Module 04's `stock_movements` and Module 05's own `dispense_records` double as ledgers *and* audit trails per `00-shared-conventions.md` §4).

### 3.6 MatchRequest (aggregate root)
Existing model reused as-is. `chosenResult` (`Json`) shape for Slice 1 (single-pharmacy only, §0.2): `{ pharmacyId, branchId, lines: [{ catalogProductId, listingId, reservationId, quantity }] }`.

### 3.7 MatchCandidate (entity — ranked snapshot)
Existing model reused as-is. `rating`/`ratingCount` columns exist but are **never written by Slice 1** (§0.2) — always `null`, exactly like Module 04's `Pharmacy.ratingAvg` being "reserved for Module 15, read-only pass-through."

### 3.8 Value Objects
- `PrescriptionStatus`, `VerificationDecision`, `MatchStatus`, `MatchStrategy`, `MatchCoverage` — re-exported Prisma enums at the domain layer (`domain/enums.ts`), same convention as Modules 02/03/04.
- `RemainingDispensable` — non-negative integer wrapper; `RemainingDispensable.compute(approvedQty, dispensedSum)` floors at 0 and throws if `dispensedSum > approvedQty` (should never happen if invariant §3.11.3 holds — this is a defensive assertion, not a normal code path).
- `RejectionReason` — non-empty, trimmed string wrapper, 3–500 chars (mirrors Module 04's `AdjustBatchDto.reason` mandatory-reason pattern).
- `ValidityPeriod` — `{ issueDate?: Date; expiryDate?: Date }`, `isExpired(asOf: Date): boolean` (false if `expiryDate` is null — see §20 Q2 for the "no stated expiry" default).
- `RankingWeights` — `{ distanceWeight: number; priceWeight: number }` (no rating weight in Slice 1 — see §0.2), read via `IConfigPort` key `matching.rankingWeights` (module-namespaced per `00-shared-conventions.md` §10's corrected convention, same as Module 04's `inventory.reservationTtlMinutes`).

### 3.9 Domain Services (pure, framework-free)
- **`PrescriptionGate`** — `check(lines: { catalogProductId, isRx }[], candidateLines: PrescriptionLineSnapshot[], now: Date): { allowed: boolean; blocked: BlockedItem[] }`. Encodes FR-MED-10, BRULE-10/11/12. Pure function over snapshots passed in by the application-layer command (which fetches them via repositories/`ICatalogPort`) — matches the "pure domain service, orchestration in application layer" split Module 04 used for `TransactingEligibilityPolicy` vs. `ReservationManager`.
- **`DispensingPolicy`** — `canDispense(line: { remainingDispensable, expiryDate }, requestedQty: number, now: Date): DispenseDecision` (`OK | EXHAUSTED | EXPIRED`). Encodes BRULE-11/12.
- **`MatchRankingStrategy`** — `rank(candidates: AvailabilityCandidate[], weights: RankingWeights): RankedCandidate[]` — `score = weights.distanceWeight · norm(distance) + weights.priceWeight · norm(totalPrice)`, distance-dominant by default (FR-MATCH-02). Pure, unit-testable with fixed candidate arrays (no DB, no geo service).
- **`VerificationPolicy`** — `canReview(reviewerUserId, prescription, isPharmacistAtPharmacy: boolean): boolean` — encodes Model A (§4): reviewer must be `PHARMACIST`-role at `prescription.verifyingPharmacyId`'s org, and must not be the uploading customer (mirrors Module 01's `VerificationRequest.assertReviewable`'s self-review guard — same shape, independently owned copy per ADR-002).

### 3.10 Application-layer orchestrators (not pure — need repositories/ports)
- **`MatchingEngine`** (`FindMatchCommand`) — calls `IAvailabilityPort` per order line, groups by pharmacy (single-pharmacy coverage only, §0.2), ranks via `MatchRankingStrategy`, persists `MatchRequest`+`MatchCandidate` snapshot rows.
- **`RematchOrchestrator`** (`RematchCommand`) — releases any held reservations for the current `chosenResult` (via `IAvailabilityPort`/`IInventoryPort.release`), excludes the declined pharmacy, re-ranks remaining candidates, or transitions to `FAILED` if none remain (BRULE-19).

### 3.11 Invariants (safety-critical)
1. A prescription reaches `APPROVED` **only** via a `VerificationReview(decision=APPROVED)` written by a user holding `PHARMACIST` at `verifyingPharmacyId`'s organization, who is **not** the uploading customer (BRULE-10, mirrors Module 01's self-review guard).
2. A `REJECTED` transition **requires** a non-empty `rejectionReason` (BRULE-14) — the command throws `REJECTION_REASON_REQUIRED` before any write if absent; this is enforced at the **command layer**, not just DTO validation, because `RejectionReason` VO construction is the single source of truth (same "business rule, not DTO shape" split Module 02 used for its DOB rule).
3. `remainingDispensable(line) = approvedQuantity − Σ(dispense_records.quantity for that line)`; **never negative**; a dispense that would make it negative is rejected before any write (BRULE-12, FR-RX-09) — computed **inside** the same `Serializable`-isolated transaction as the dispense insert, re-read fresh from that transaction's snapshot before the check (never trusting a pre-transaction read — the same "recompute inside the transaction" discipline Module 04's `AddBatchCommand`/`AdjustBatchCommand` hardening fix encoded), with a bounded retry (§2.1.1/§8.1, ADR-013) resolving the rare case where Postgres aborts one side of a genuine concurrent write-write conflict on the same line. **Correction from the first draft:** the mechanism is `Serializable` isolation + retry (Module 02/03 precedent), **not** `SELECT ... FOR UPDATE` under `Read Committed` (Module 04's precedent) — see §2.1.1 for why Module 05 does not copy Module 04's isolation choice.
4. A prescription past `expiryDate` (when set) is treated as expired for **gate and dispense** purposes regardless of its persisted `status` column — `status` is not proactively swept to `EXPIRED` by a background job in Slice 1 (no such sweeper is proposed here; unlike Module 04's `LicenseExpirySweeper`, an un-swept expired prescription has no "other pharmacies see stale data" side effect — the check is always live at gate/dispense time, so a lazy check is sufficient and avoids adding a fourth cron job to Phase 1). **Resolved as §20 Decision 5** — no sweeper; a derived, non-persisted `displayStatus` is computed at read time instead (see §10.1) to close the reporting/UX gap without a new cron job.
5. The `PrescriptionGate` allows an Rx line only if there exists an `APPROVED`, non-expired `PrescriptionLine` for the **same** `catalogProductId` (substitute-product matching, BRULE-16, is **out of scope**, §0.2) owned by `customerUserId`, with `remainingDispensable ≥ requestedQty`.
6. A `MatchRequest` may only select pharmacies Module 04's availability query already returned (which already excludes ineligible/suspended/expired-license pharmacies, BRULE-18) — Module 05 does **not** re-implement `TransactingEligibilityPolicy`; it trusts Module 04's filter and does not re-query pharmacy status directly (no `IIdentityPort`/pharmacy-status read needed for matching itself — only for verification reviewer checks, §2.1).
7. Every dispense produces exactly one `DispenseRecord` and is expected to correspond to exactly one Module 04 `stock_movements` (`DISPATCH`) row — reconciled by a dedicated test (§18.3), not enforced by a DB constraint across bounded contexts (ADR-002 — no cross-module FK).
8. `MatchRequest.status` transitions only `PENDING → MATCHED`, `MATCHED → REMATCHING → MATCHED`, or `→ FAILED` (terminal, no candidates left) — an invalid transition (e.g. selecting on a `FAILED` request) throws `INVALID_MATCH_STATE_TRANSITION` (§15.2 — a distinct code from `INVALID_PRESCRIPTION_STATE_TRANSITION`, one per aggregate, mirroring Module 03's one-entity-one-code convention).

---

## 4. Verification Model Decision (who verifies?) — confirmed for Slice 1

Per the parent doc §6, **Model A (dispensing pharmacy verifies) is confirmed as the Slice 1 default**, with no config-driven Model B path built yet (the parent doc's "supports both via a `VerificationPolicy` config" is **not** built in Slice 1 — `VerificationPolicy` in Slice 1 hard-codes Model A; making it config-driven is deferred until Model B has an actual staffing/queue design, per §0.2's "no speculative machinery" principle applied consistently with how Module 04 treated its own deferred items).

**Consequence for the order-independent flow:** because a prescription's `verifyingPharmacyId` is only known **once a pharmacy is chosen** (via matching, which itself may depend on Rx being resolvable — a chicken-and-egg the parent doc's own sequence diagram (§11.1) resolves by running matching *before* verification for Rx items), Slice 1's flow is:
1. Customer uploads prescription (status `UPLOADED`, `verifyingPharmacyId = null`).
2. Matching runs against **all** cart lines (Rx and OTC) treating Rx lines as "requires this product to be in stock," not yet gating on approval — availability doesn't care about Rx status, only Module 06's later order-placement gate does.
3. Once a pharmacy is selected (`SelectMatchCommand`), Module 06 (in the future) calls `AssignVerifyingPharmacyCommand({ prescriptionId, pharmacyId })` — transitions `UPLOADED/CLARIFICATION_REQUESTED → PENDING_VERIFICATION`, sets `verifyingPharmacyId`.
4. Pharmacist at that pharmacy reviews via the queue.

This ordering (`match → assign → verify`) is a Slice-1-specific sequencing decision **not spelled out explicitly** in the parent doc's §11.1 (which shows verification following matching but doesn't name the linking command). **Resolved as §20 Decision 6:** Module 05 implements and exposes `AssignVerifyingPharmacyCommand` now as an internal port method, testable standalone; the exact point Module 06's future checkout saga calls it from remains a joint Module 06 design decision to confirm later, but does not block Module 05's own implementation.

---

## 5. Validation Rules (DTO-level, `class-validator`, same `ValidationPipe` config as Modules 02/03/04: `whitelist: true, forbidNonWhitelisted: true, transform: true`)

### 5.1 Prescription — `UploadPrescriptionDto` (`POST /prescriptions`)
```ts
class UploadPrescriptionDto {
  @IsString() @Length(1, 500) fileRef!: string; // opaque, client-supplied (§2.3)
  @IsOptional() @IsString() @Length(1, 500) encryptionKeyRef?: string;
  @IsIn(['image/jpeg', 'image/png', 'application/pdf']) fileType!: string;
  @IsOptional() @IsUUID() beneficiaryId?: string; // opaque, unenforced (§2.2)
  @IsOptional() @IsString() @Length(1, 200) doctorName?: string;
  @IsOptional() @IsString() @Length(1, 200) hospitalName?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsDateString() expiryDate?: string; // must be >= issueDate if both present
}
```
- Business validation (command layer): `expiryDate ≥ issueDate` when both present, else `422 VALIDATION_ERROR`.

### 5.2 Verification — `ApprovePrescriptionDto` / `RejectPrescriptionDto` / `RequestClarificationDto`
```ts
class ApproveLineDto {
  @IsOptional() @IsString() @Length(1, 500) rawText?: string;
  @IsUUID() catalogProductId!: string;
  @IsInt() @Min(1) approvedQuantity!: number;
  @IsInt() @Min(0) refillsAllowed!: number;
  @IsBoolean() isSingleUse!: boolean;
}
class ApprovePrescriptionDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ApproveLineDto)
  lines!: ApproveLineDto[];
  @IsBoolean() legibilityOk!: boolean;
  @IsBoolean() validityOk!: boolean;
}
class RejectPrescriptionDto {
  @IsString() @Length(3, 500) reason!: string; // mandatory, BRULE-14
}
class RequestClarificationDto {
  @IsString() @Length(3, 500) message!: string;
}
```
- Business validation (command layer, not DTO — same split as Module 02's DOB rule / Module 04's eligibility rule): each `catalogProductId` resolves via `ICatalogPort.getProduct()` to a non-deleted, `ACTIVE` product → otherwise `404 CATALOG_PRODUCT_NOT_FOUND`; reviewer must pass `VerificationPolicy.canReview()` → otherwise `403 VERIFICATION_FORBIDDEN`; prescription must be in `PENDING_VERIFICATION` → otherwise `409 INVALID_PRESCRIPTION_STATE_TRANSITION`.

### 5.3 Rx Gate — `CheckRxGateDto` (internal, not an HTTP DTO — a port method input; see §10.4)
```ts
interface CheckRxGateInput {
  customerUserId: string;
  beneficiaryId?: string; // accepted, unenforced (§2.2)
  items: Array<{ catalogProductId: string; quantity: number }>;
}
```

### 5.4 Dispensing — `DispenseMedicineDto` (internal port method input)
```ts
interface DispenseMedicineInput {
  prescriptionLineId: string;
  idempotencyKey: string; // REQUIRED — resolves §20 Decision 7 / §6.3; DB-enforced via @@unique([prescriptionLineId, idempotencyKey])
  orderId: string;
  pharmacyId: string;
  quantity: number;
  stockMovementId?: string; // Module 04 reconciliation reference, §3.11.7
}
```

### 5.5 Matching — `FindMatchDto` / `SelectMatchDto` / `RematchDto`
```ts
class OrderLineDto {
  @IsUUID() catalogProductId!: string;
  @IsInt() @Min(1) quantity!: number;
}
class FindMatchDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
  @IsOptional() @IsLatitude() deliveryLat?: number;
  @IsOptional() @IsLongitude() deliveryLng?: number;
}
class SelectMatchDto {
  @IsOptional() @IsUUID() pharmacyId?: string; // omitted = accept rank #1
}
```
- `(deliveryLat, deliveryLng)` both-or-neither, same rule as Module 04's branch `(lat, lng)` validation.
- Business validation: split fulfillment is **not offered** in Slice 1 — if no single pharmacy covers every line, the result is `NO_PHARMACY_MATCH` (not a partial/split proposal), per §0.2.

---

## 6. Database Requirements

### 6.1 Already correct, no change needed
All tables in `prisma/schema/05-prescription.prisma` — `prescriptions`, `prescription_lines`, `verification_reviews`, `dispense_records`, `prescription_access_log`, `match_requests`, `match_candidates` — already match the shape needed for Slice 1's aggregates (§3) *except* the two gaps in §6.2/§6.6 below, which this review resolves as **required**, not merely "proposed." This is a materially different outcome from Module 04's "zero must-fix schema changes" — Module 05's schema, unlike Module 04's, has two real correctness gaps, not just optional performance indexes.

### 6.2 REQUIRED migration (blocking — not yet applied) — `PrescriptionStatus.CONSUMED` is missing
**Finding (resolves §20 Q8):** the parent architecture doc (`architecture/module-05-prescription-matching.md` §5.2) names `CONSUMED` as a value of the `PrescriptionStatus` value object. The actual Prisma enum in `prisma/schema/05-prescription.prisma` is:
```prisma
enum PrescriptionStatus {
  UPLOADED
  PENDING_VERIFICATION
  APPROVED
  REJECTED
  CLARIFICATION_REQUESTED
  EXPIRED
  DOCTOR_ISSUED
}
```
— **`CONSUMED` was never added.** This is confirmed **stale/incomplete on the code side**, not a misreading of the architecture doc: the dispensing invariant (§3.11.3/§8.1) requires a terminal status for a fully-dispensed, single-use prescription (`remainingDispensable = 0 AND isSingleUse = true`), and `APPROVED` is not that terminal state (an `APPROVED`-but-exhausted prescription must still be rejected by the gate, §3.11.5, but leaving it labeled `APPROVED` forever is misleading in every list/detail view and in `GET /prescriptions`).
**Decision:** add `CONSUMED` to the `PrescriptionStatus` enum. **Required migration, must land before Module 05 implementation begins** (this is a `Prisma` schema change, category "production-code changes before Module 05" per this review's taxonomy — not a documentation-only fix, since the dispense flow's core safety logic depends on it).
```prisma
enum PrescriptionStatus {
  UPLOADED
  PENDING_VERIFICATION
  APPROVED
  REJECTED
  CLARIFICATION_REQUESTED
  EXPIRED
  CONSUMED   // NEW — terminal state once a single-use, fully-dispensed prescription hits remainingDispensable = 0
  DOCTOR_ISSUED
}
```
This is an additive enum change (ADR-003/`00-domain-event-catalog.md` §3 rule 1, "additive evolution only") — safe, no data migration needed for existing rows (there are none yet, Module 05 is unimplemented).

### 6.3 REQUIRED migration (blocking — not yet applied) — dispense idempotency/replay guard
**Finding (resolves §20 Q7):** `dispense_records` currently has no uniqueness constraint and `DispenseMedicineInput` (§5.4) carries no idempotency key. A retried `DispenseMedicine` call (e.g. a Module 06 fulfillment worker retrying after a timeout, or a duplicate webhook-style trigger, once Module 06 exists) has no database-enforced guard against creating a second `DispenseRecord` for the same logical dispense — this is a genuine, safety-relevant gap for BRULE-12 (anti-reuse), not a hypothetical one, since the exact same class of bug (`DEFECT-PROFILES-001`, a missing partial-unique-index) was already found and fixed once in Module 02.
**Decision:** add an explicit `idempotencyKey` column to `dispense_records`, required on every insert (mirroring Module 04's `ReserveStockDto.idempotencyKey`, `00-shared-conventions.md` §7 "idempotency keys on ... booking mutations" — a dispense is exactly this kind of mutation), enforced by a **database-level unique constraint** (preferred per this review's instruction to favor a DB-enforced invariant over an application-only check):
```prisma
model DispenseRecord {
  // ...existing fields...
  idempotencyKey     String   // NEW — required, client/caller-supplied
  // ...
  @@unique([prescriptionLineId, idempotencyKey])   // NEW
}
```
`DispenseMedicineInput` (§5.4) gains `idempotencyKey: string` (required, `@IsString() @Length(1, 100)`), and `DispenseMedicineCommand`'s transaction becomes: `SELECT` current line state (fresh, inside the `Serializable` transaction per §2.1.1) → attempt the `dispense_records` insert → if it hits the unique constraint, this is a **replay**, not an error: return the original `DispenseRecord`'s id (same "replay returns the original result" contract as `00-shared-conventions.md` §7) rather than surfacing `409`. **Required migration, must land before Module 05 implementation begins** — category "production-code changes before Module 05."

### 6.4 Recommended migration (non-blocking, performance) — verification queue and access indexes
The verification queue (§10.2) filters `WHERE status = 'PENDING_VERIFICATION' AND verifyingPharmacyId = ?`; `prescriptions` currently has no index covering this. Recommend:
```
@@index([verifyingPharmacyId, status])
@@index([customerUserId])          // "list own prescriptions" (F-RX-06)
```
`match_requests` currently has no index for a future timeout sweeper's scan (`WHERE status IN ('PENDING','MATCHED') AND updatedAt < ?`, needed once a `MatchTimeoutSweeper` is built — not in Slice 1, see §8.4). Recommend:
```
@@index([status, updatedAt])
```
Unlike §6.2/§6.3, these are **performance-only, not correctness-blocking** — Slice 1's data volumes do not require them on day one, but landing them in the same prerequisite migration as §6.2/§6.3 avoids a second migration immediately after launch, mirroring Module 04's own §6.2 recommendation being bundled into its implementation PR rather than deferred to a follow-up.

### 6.5 Proposed enum addition (NOT applied, NOT blocking) — individual pharmacist licensing gap
`prisma/schema/01-identity.prisma`'s `VerificationType` enum has `FAYDA | PHARMACY_LICENSE | DRIVER_DOCS | DOCTOR_LICENSE` — **no `PHARMACIST_LICENSE`**, even though `DOCTOR_LICENSE` (an individual professional license) already exists for the analogous doctor case. This means Identity currently has **no way to verify an individual pharmacist's professional credential** — "licensed pharmacist" in Slice 1 can only mean "has the `PHARMACIST` RBAC role at a verified pharmacy organization" (an org-membership fact), not an independently verified professional license (a person fact), which is what BR-RX-03/BRULE-10 actually intend. **Decision (resolves §20 Q3):** accept the RBAC-role-as-proxy interim for Slice 1 (§4 already documents this); recommend adding `PHARMACIST_LICENSE` to Module 01's enum in a **future, separate Module 01 migration/slice**, not as part of Module 05's prerequisite migration (it is Identity's schema, Identity's ownership, and not required for Module 05's own correctness — only for closing a real-world compliance gap Module 05 cannot itself close). Category: **future/deferred decision, prerequisite module/slice (Module 01), not blocking Module 05.**

### 6.6 Summary — schema changes required before Module 05 implementation
| Change | File | Blocking? | Category |
| --- | --- | --- | --- |
| Add `CONSUMED` to `PrescriptionStatus` | `prisma/schema/05-prescription.prisma` | **Yes** | Production-code change before Module 05 (§6.2) |
| Add `DispenseRecord.idempotencyKey` + `@@unique([prescriptionLineId, idempotencyKey])` | `prisma/schema/05-prescription.prisma` | **Yes** | Production-code change before Module 05 (§6.3) |
| `@@index([verifyingPharmacyId, status])`, `@@index([customerUserId])` on `Prescription`; `@@index([status, updatedAt])` on `MatchRequest` | `prisma/schema/05-prescription.prisma` | No (performance) | Recommended, bundle into the same migration |
| Add `PHARMACIST_LICENSE` to `VerificationType` | `prisma/schema/01-identity.prisma` | No | Future Module 01 slice, not a Module 05 blocker |

No other schema changes are required — nullability, relation shapes, and the remaining table structures were already frozen correctly for this slice's needs.

---

## 7. Permissions (RBAC)

### 7.1 Reused, no change
`prescription:upload:own` (granted to `CUSTOMER`) and `prescription:verify` (granted to `PHARMACIST`) already exist in `prisma/rbac-catalog.ts` — both were seeded in anticipation of this module and are **already wired to no route** (dead until this slice ships), exactly the same "seeded ahead of the consuming module" pattern the catalog file already uses for `availability:read:any`.

### 7.2 New permissions to add to `prisma/rbac-catalog.ts` (proposed, NOT applied by this spec)
| Key | Resource | Action | Scope | Granted to |
| --- | --- | --- | --- | --- |
| `prescription:read:own` | `prescription` | `read` | `own` | `CUSTOMER` (list/view/reupload own prescriptions — separate from `upload:own` since read and write are distinct concerns, consistent with Module 02's `address:read:own`/`address:manage:own` split) |
| `matching:read:own` | `matching` | `read` | `own` | `CUSTOMER` (view own `MatchRequest` status/candidates) |
| `matching:create:own` | `matching` | `create` | `own` | `CUSTOMER` (find/select/rematch — these are customer-initiated actions in Slice 1's model, since Module 06's checkout saga doesn't exist yet to call them server-side; **once Module 06 exists, these become internal port calls the same way Module 04's reserve/confirm/release became `IInventoryPort`-only, §10.4 note**) |

**No permission is added for the Rx gate or dispensing.** These are internal port methods (`ICheckRxGatePort`/`IDispensingPort`, §11), consumed in-process by Module 06 exactly like Module 04's reserve/confirm/release — no HTTP route, no permission key, per the confirmed §10.3/§14.6 convention Module 04 established.

### 7.3 Guarding
- `POST /prescriptions`, `GET /prescriptions`, `GET /prescriptions/:id`, `POST /prescriptions/:id/reupload` → `@RequirePermissions('prescription:upload:own')` for create, `'prescription:read:own'` for reads; ownership enforced in the application layer (`prescription.customerUserId === currentUser.id`), same "scope validated in the application layer" split as every prior module (`00-shared-conventions.md` §2).
- `GET /pharmacy/verification/queue`, `GET /pharmacy/verification/:id`, `POST .../approve|reject|clarify` → `@RequirePermissions('prescription:verify')`; org-scope enforced by comparing `prescription.verifyingPharmacyId`'s owning organization against the caller's `user_roles.organizationId`, resolved via `IIdentityPort.getUserOrganizationIds()` (§2.1) — same pattern Module 04 used for `pharmacy:manage:org`.
- `POST /matching/find`, `GET /matching/:id`, `POST /matching/:id/select`, `POST /matching/:id/rematch` → `@RequirePermissions('matching:create:own')`/`'matching:read:own'`; ownership via `matchRequest.customerUserId`.
- **Rx gate and dispense** → not HTTP routes; `ICheckRxGatePort`/`IDispensingPort` methods exported for Module 06, per §7.2/§11.
- No `@Public()` routes in this module — unlike Module 04's availability browse, nothing in Module 05 is meant for unauthenticated access (prescriptions are always sensitive; matching always requires a logged-in customer with a cart).

---

## 8. Concurrency & Correctness-Critical Flows

### 8.1 Dispensing (anti-reuse, BRULE-12) — the safety-critical ledger write
Single DB transaction at **`Serializable` isolation**, wrapped in a bounded-retry helper (`runWithMatchRetry`/`runWithDispenseRetry`, Module 05's own copy of Module 03's `runWithDedupRetry` pattern, per §2.1.1/ADR-013 — **not** Module 04's `Read Committed`+`FOR UPDATE` pattern):
1. Open the transaction (`Serializable`).
2. Read the current `PrescriptionLine` state fresh, inside the transaction (never trust a pre-transaction read).
3. Idempotency check (§6.3): does a `dispense_records` row already exist for `(prescriptionLineId, idempotencyKey)`? If yes, this is a **replay** — return the existing record's id, do not re-check policy or re-decrement anything (mirrors `00-shared-conventions.md` §7's replay contract).
4. Check `DispensingPolicy.canDispense()` — `remainingDispensable ≥ quantity` and the parent prescription is not expired; else `409 PRESCRIPTION_EXHAUSTED`/`PRESCRIPTION_EXPIRED`, transaction rolled back (no partial write).
5. Insert `dispense_records` row (append-only, carries `idempotencyKey`).
6. Recompute and cache `dispensedQuantity += quantity`, `remainingDispensable -= quantity` on the line (derived cache, ADR-006 — never independently mutated).
7. If `remainingDispensable = 0` and `isSingleUse`, cascade the **parent** `Prescription.status → CONSUMED` (§6.2 — now a real enum value, not a design/schema drift).
8. Write audit entry `MEDICINE_DISPENSED` via `AuditService.record(..., tx)` (actor = dispensing staff or system, per §13) — safe under `Serializable`, per §2.1.1.
9. Write outbox `MedicineDispensed` event (same transaction, ADR-010).
10. Commit. If Postgres raises a serialization failure (`P2034`/`40001`/`40P01`) because a concurrent dispense against the *same line* also committed first, the retry wrapper re-runs the whole closure from step 2 against the now-committed state (bounded to 5 attempts, exhausting to a deterministic `409 CONFLICT`, never an unhandled `500` — same contract as Module 03's `runWithDedupRetry`).
- **Why `Serializable`, not `FOR UPDATE`+`Read Committed` (resolves §20 Q7's mechanism question):** `Serializable` isolation makes the audit-chain fork-safety (§2.1.1) and the ledger race-safety (this section) **the same mechanism** — one isolation level and one retry wrapper cover both concerns, rather than needing a row lock for one and a separate discipline for the other. This is a **stronger** guarantee than Module 04's combination, appropriate given Module 05 is the first module whose mutations are simultaneously safety-critical (BRULE-12) and audit-chain-carrying in the same transaction.

### 8.2 Rx Gate — read-only, no lock or transaction needed
`CheckRxGateCommand` reads (not locks) the customer's `APPROVED`, non-expired `PrescriptionLine`s matching each requested `catalogProductId`, sums `remainingDispensable` per product, and compares against requested quantity. **No transaction required** — this is a query, not a mutation; Module 06 is expected to call it, then separately call dispense (§8.1) at actual fulfillment time, so a gate-check race (stock checked available, then consumed by another concurrent order before dispense) is caught by `DispensingPolicy` at dispense time, not by the gate — same "check-then-act is advisory, the real lock is at the mutating step" pattern as Module 04's availability read vs. its reserve transaction.

### 8.3 Matching — mostly read/ranking, one write-path atomicity point
`FindMatchCommand` writes `MatchRequest`+`MatchCandidate` rows after a purely read-only ranking computation over `IAvailabilityPort` (no lock needed for the reads — ranking is stateless per the parent doc §8's design rationale). Its own persistence step still follows §2.1.1's rule (state + audit + outbox in one `Serializable` transaction, bounded retry) even though the "audit" here is lighter-weight (a `MATCH_REQUEST_CREATED` entry) — consistency of mechanism matters more than the size of the write. `SelectMatchCommand` and `RematchCommand` update `MatchRequest.status`/`chosenResult` in their own `Serializable` transaction and **separately** call Module 04's `IInventoryPort.reserve()`/`.release()` (already hardened with its own `FOR UPDATE` + idempotency key, §8 of the Module 04 spec, run in Module 04's *own* transaction) — this is the accepted, documented two-transaction seam formalized in **ADR-014** (`architecture/00-decision-log.md`), not a single distributed transaction (Prisma/Postgres cannot span two independently-owned unit-of-work implementations without collapsing the module boundary, ADR-001/002). See §12 for the exact orphan/compensation story this implies.

### 8.4 Re-match / timeout — no sweeper in Slice 1
The parent doc §14 (future scalability) and its own sequence flow (§11.4) mention a `MatchTimeoutSweeper`. **Slice 1 does not build this** — `RematchCommand` is **explicitly triggered** (by the chosen pharmacy declining via a future Module 06/09-style "decline" action, or by the customer manually retrying), not by a background timeout scan, mirroring how Module 04 deferred its own `LicenseExpirySweeper`-adjacent auto-decisions where no concrete trigger existed yet. §6.3's proposed `@@index([status, updatedAt])` is forward-looking for when a sweeper is justified (Module 05 — Slice 2, once real decline/timeout UX is specified by Module 06).

---

## 9. Domain Events Emitted (published to `EVENT_BUS` via the outbox, same transaction as the state change, per ADR-010)

| Event | Payload | Trigger |
| --- | --- | --- |
| `PrescriptionUploaded` | `{ prescriptionId, customerUserId }` | `UploadPrescriptionCommand` |
| `PrescriptionApproved` | `{ prescriptionId, lines: [{ lineId, catalogProductId, approvedQuantity }] }` | `ApprovePrescriptionCommand` |
| `PrescriptionRejected` | `{ prescriptionId, reason }` | `RejectPrescriptionCommand` |
| `MedicineDispensed` | `{ prescriptionLineId, orderId, quantity }` | `DispenseMedicineCommand` (§8.1) |
| `OrderMatched` | `{ matchRequestId, orderId, result: MatchRequest['chosenResult'] }` | `SelectMatchCommand` succeeds |
| `RematchTriggered` | `{ matchRequestId, excludedPharmacyId }` | `RematchCommand` finds a new candidate |
| `MatchFailed` | `{ matchRequestId }` | `RematchCommand` exhausts all candidates |

These match `00-domain-event-catalog.md`'s Module 05 row exactly — no additions or omissions beyond what's already contracted, unlike Module 04 which had to add `ListingDisabled` beyond its parent doc's list. **Note:** `OrderMatched`'s `orderId` field will be `null`/absent until Module 06 exists and actually creates an order to reference — the event still fires (a `MatchRequest` can exist and resolve pre-order, per `match_requests.orderId` being nullable in schema) but early consumers (none exist yet) must handle a null `orderId`.

**Contract-testing note:** every event above must validate against `00-domain-event-catalog.md`'s Module 05 row once this slice is implemented, per `00-implementation-roadmap.md` §5 "Contract tests," identical requirement to every prior module.

---

## 10. API Contracts

Base paths per parent doc §9 and `00-shared-conventions.md` §1: `/api/v1/prescriptions`, `/api/v1/pharmacy/verification`, `/api/v1/matching`. Bearer auth via global guards; envelope/errors per §1 of shared conventions. No `@Public()` routes (§7.3).

### 10.1 Prescriptions (customer)
- **POST `/prescriptions`** — body per §5.1. → `201 { prescriptionId, status: 'UPLOADED' }`. Emits `PrescriptionUploaded`.
- **GET `/prescriptions`** — list own, paginated, filterable by `status?`. Each item includes a **derived, non-persisted `displayStatus`** field (§20 Decision 5): `EXPIRED` if `expiryDate` is past and the stored `status` is not already terminal, else the stored `status` verbatim — computed at query time, no schema change, no cron sweeper.
- **GET `/prescriptions/:id`** — detail, including the same derived `displayStatus`. **Audited** (`PrescriptionAccessLog`, allow/deny) regardless of outcome (FR-REC-06). Returns `fileRef` as-is (no pre-signed URL minting in Slice 1 — that requires `IStoragePort`, §2.3; the client is expected to already know how to resolve `fileRef` against whatever external store it used to upload).
- **POST `/prescriptions/:id/reupload`** — respond to a `CLARIFICATION_REQUESTED` status; body = same shape as §5.1's file fields; → status back to `PENDING_VERIFICATION` (or `UPLOADED` if not yet assigned to a pharmacy).

### 10.2 Verification (pharmacist — `prescription:verify`)
- **GET `/pharmacy/verification/queue`** — pending prescriptions scoped to the caller's pharmacy org (`verifyingPharmacyId`), paginated (no SLA sort in Slice 1, §0.2).
- **GET `/pharmacy/verification/:id`** — view + audited access.
- **POST `/pharmacy/verification/:id/approve`** — body per §5.2. → `200`. Emits `PrescriptionApproved`.
- **POST `/pharmacy/verification/:id/reject`** — body `{ reason }`. → `200`. Emits `PrescriptionRejected`.
- **POST `/pharmacy/verification/:id/clarify`** — body `{ message }` → status `CLARIFICATION_REQUESTED`. No domain event in Slice 1 (not in `00-domain-event-catalog.md`'s Module 05 row — adding one now with no cataloged consumer would repeat Module 04's own explicitly-avoided mistake of "dead code event").

### 10.3 Matching (customer)
- **POST `/matching/find`** — body per §5.5. → ranked candidates + `matchRequestId`. `NO_PHARMACY_MATCH` if empty.
- **GET `/matching/:id`** — status + candidates + chosen result.
- **POST `/matching/:id/select`** — body `{ pharmacyId? }`. → reserves stock via `IInventoryPort` (delegated, §2.1), returns `chosenResult`; status → `MATCHED`.
- **POST `/matching/:id/rematch`** — excludes current pharmacy, re-ranks; `NO_PHARMACY_MATCH`/`MATCH_FAILED` if none remain.

### 10.4 Internal ports (no HTTP surface — RESOLVED, consistent with Module 04 §10.3/§14.6)
- **`ICheckRxGatePort.check(input: CheckRxGateInput): Promise<{ allowed: boolean; blocked: BlockedItem[]; usablePrescriptionLineIds: string[] }>`** — exported for Module 06.
- **`IDispensingPort.dispense(input: DispenseMedicineInput): Promise<{ dispenseRecordId: string }>`** — exported for Module 06/08 fulfillment.
- **Why no HTTP surface (reasoning reused verbatim from Module 04 §10.3):** both are called exclusively by other in-process modules under ADR-001's single-deployable model; routing through HTTP back into the same process adds latency and would require inventing an internal-service-auth scheme that exists nowhere else in the codebase. If Module 05 is ever extracted to a separate deployable, these ports' adapters become HTTP/gRPC clients with no change to callers' code — that is the point at which a real service-to-service auth ADR gets written, not before.

**Representative errors (see §15.2 for the full `ErrorCode` extension table and HTTP mappings):** `PRESCRIPTION_NOT_FOUND`, `PRESCRIPTION_EXPIRED`, `PRESCRIPTION_NOT_APPROVED`, `PRESCRIPTION_EXHAUSTED`, `RX_REQUIRED`, `REJECTION_REASON_REQUIRED`, `VERIFICATION_FORBIDDEN`, `NO_PHARMACY_MATCH`, `MATCH_CANDIDATE_UNAVAILABLE`, `MATCH_FAILED`, `INVALID_PRESCRIPTION_STATE_TRANSITION`, `INVALID_MATCH_STATE_TRANSITION`, `CATALOG_PRODUCT_NOT_FOUND`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `CONFLICT`. Access denials on prescriptions return a **generic 403** without leaking existence, per `00-shared-conventions.md` §1 "privacy denials return generic 403."

---

## 11. NestJS Module Layout (Clean Architecture) — proposed for the implementation PR

```
src/modules/prescription-matching/
  domain/
    entities/            # Prescription, PrescriptionLine, VerificationReview, DispenseRecord,
                          # MatchRequest, MatchCandidate
    value-objects/       # RemainingDispensable, RejectionReason, ValidityPeriod, RankingWeights
    events.ts            # PrescriptionUploaded, PrescriptionApproved, PrescriptionRejected,
                          # MedicineDispensed, OrderMatched, RematchTriggered, MatchFailed
    enums.ts             # re-exported Prisma enums (PrescriptionStatus, VerificationDecision, MatchStatus, MatchStrategy)
    repositories/        # IPrescriptionRepository, IVerificationRepository, IDispenseLedgerRepository, IMatchRepository
    services/            # PrescriptionGate, DispensingPolicy, MatchRankingStrategy, VerificationPolicy
  application/
    commands/            # UploadPrescription, ApprovePrescription, RejectPrescription, RequestClarification,
                          # AssignVerifyingPharmacy, DispenseMedicine, FindMatch, SelectMatch, Rematch
    queries/              # GetPrescription, ListPrescriptions, GetVerificationQueue, GetMatchResult
    ports/
      inbound/            # ICheckRxGatePort, IDispensingPort — this module's own exported contract
                          # (mirrors Module 04's ports/inbound/IInventoryPort precedent)
      outbound/           # ICatalogPort, IIdentityPort, IAvailabilityPort, IConfigPort (reused from shared/),
                          # IUnitOfWork, INotificationPort
    support/              # runWithMatchRetry/isRetryableTransactionConflict — own copy of Module 03's
                          # dedup-conflict.ts pattern (§2.1.1, ADR-013), NOT a cross-module import (ADR-002)
    dtos/ mappers/
  infrastructure/
    persistence/prisma/   # Prisma*Repository implementations; transactional dispense at Serializable isolation + bounded retry (§8.1, §2.1.1, ADR-013)
    catalog/               # CatalogPortAdapter (own copy, direct PrismaService read of Product, per ADR-002)
    identity/              # IdentityPortAdapter (own copy, direct PrismaService read of user_roles/roles)
    availability/          # AvailabilityPortAdapter — direct Nest DI injection of Module 04's exported
                          # GetAvailabilityQuery + IInventoryPort (imports PharmacyInventoryModule)
  interface/
    http/
      controllers/         # PrescriptionController, VerificationController, MatchingController
                          # (no controller for the Rx gate/dispense — internal ports only, §10.4)
      dtos/ guards/ decorators/ filters/
  prescription-matching.module.ts   # imports: [PharmacyInventoryModule]; exports: [CHECK_RX_GATE_PORT, DISPENSING_PORT]
                                     # so Module 06 (later) can inject both directly — no HTTP round-trip
```

**Rationale.** Identical dependency rule to `00-shared-conventions.md` §13: domain ← application ← infrastructure/interface, domain framework-free. The `ports/inbound` vs `ports/outbound` split (established by Module 04, reused here) reflects that Module 05 is, like Module 04, both a port **consumer** (Catalog, Identity, Availability) and a port **provider** (`ICheckRxGatePort`/`IDispensingPort` for Module 06). Unlike the parent doc's proposed `storage/`, `scanning/`, `availability/` infrastructure folders (which assumed real upload/scan infra), `storage/` and `scanning/` are **not created in Slice 1** (§2.3) — only `availability/` exists, since that dependency is real and already built.

---

## 12. Transactions — summary of atomic units

Every transaction below runs at **`Serializable` isolation with bounded retry** (§2.1.1, §8.1, ADR-013) — this is now a resolved, binding decision, not an open question.

| Operation | Atomic unit (single DB transaction, `Serializable` + bounded retry) |
| --- | --- |
| Upload prescription | prescription insert, audit entry, outbox `PrescriptionUploaded` |
| Approve prescription | prescription status update, `PrescriptionLine` inserts (one per approved line, `remainingDispensable = approvedQuantity`), `VerificationReview` insert, audit entry, outbox `PrescriptionApproved` |
| Reject prescription | prescription status update, `VerificationReview` insert, audit entry, outbox `PrescriptionRejected` |
| Dispense medicine | idempotency check, `DispenseRecord` insert, `dispensedQuantity`/`remainingDispensable` update, `status → CONSUMED` cascade if exhausted+single-use, audit entry, outbox `MedicineDispensed` (§8.1, §6.2/§6.3) |
| Find match | `MatchRequest` insert, `MatchCandidate` inserts (snapshot), audit entry — **no cross-module write**; availability reads happen *before* this transaction opens (read-only, no lock needed, §8.2/§8.3) |
| Select match | `MatchRequest` status update + `chosenResult` write in **this module's own** `Serializable` transaction, **plus** a **separate** transaction inside Module 04's `IInventoryPort.reserve()` (its own `Read Committed`+`FOR UPDATE` transaction, per the Module 04 spec) — two transactions, not one distributed transaction, per **ADR-014** (`00-decision-log.md`, added by this review). **Resolved ordering (closes §20 v1 Q9):** call `IInventoryPort.reserve()` **first**; only update `MatchRequest.status → MATCHED` **after** it returns successfully. This ordering means the only possible orphan is "reservation succeeded, but the `MatchRequest` update then fails" — which self-heals via Module 04's existing reservation TTL sweeper (ADR-007) reclaiming the unconfirmed `HELD` reservation. The reverse ordering (`MatchRequest` updated first) would instead risk a `MatchRequest` claiming `MATCHED` with no actual stock hold behind it, which has **no self-healing mechanism** — so the chosen order is not arbitrary. |
| Rematch | release via `IInventoryPort.release()` (Module 04's own transaction, called **first**, idempotent per `00-shared-conventions.md` §7) + `MatchRequest`/`MatchCandidate` updates in this module's own `Serializable` transaction (called **second**) — same ordering rationale and ADR-014 seam as above. |

Every row within a single module's `Serializable` transaction must commit or roll back **together** (ADR-006, ADR-010), following Modules 02/03's `PrismaUnitOfWork` + bounded-retry pattern (§2.1.1, ADR-013) — **not** Module 04's `Read Committed` pattern, for the reasons in §2.1.1. Module 05 should not invent a third transactional pattern.

---

## 13. Audit & Outbox

- **Audit (hash-chained, `AuditService.record()`)** — must-audit actions per `00-shared-conventions.md` §4 and the parent doc §13: prescription uploaded, viewed/downloaded (actor+role, FR-REC-06 — **every** access, allow and deny), re-uploaded; verification approved/rejected/clarified (reviewer, pharmacy, **reason** on reject); every dispense (already ledgered via `dispense_records` per `00-shared-conventions.md` §4's "module-specific immutable ledgers that double as audit trails" — a *separate* `AuditLog` row is written for the business action `MEDICINE_DISPENSED`, not duplicated per ledger row, same non-duplication rule Module 04 used for `stock_movements`); match found/selected/overridden/re-matched/failed (for compliance analytics on Rx availability, per the parent doc §13).
- **Outbox** — every event in §9 written to `outbox` in the same transaction as its triggering state change (ADR-010); reuses `OutboxService.write()` exactly as Modules 02/03/04 do — no new outbox infrastructure.
- **Isolation requirement (ADR-013, §2.1.1)** — because every audit write above happens via `AuditService.record(..., tx)` inside the same transaction as the state change and outbox write, that transaction **must** run at `Serializable` isolation with bounded retry (§8, §12). This is not optional hardening to add later — it is required from the first commit of Module 05's code, the same way Module 03 built it in from day one rather than retrofitting it as Module 02 had to.
- **Never audit or log:** prescription image contents, doctor/hospital free-text beyond what's already a non-sensitive identifier, or any clinical narrative — per `00-shared-conventions.md` §4's "never log: ...clinical content/media, plaintext health text." Operational logs (e.g. `AllExceptionsFilter` warnings) must never include `fileRef`/`encryptionKeyRef` values in a way that could resolve to the artifact outside the audited access path — flagged as a review item for the implementation PR's logging interceptor configuration.

---

## 14. Security & Privacy Requirements

- **Encryption at rest:** `fileRef`/`encryptionKeyRef` are opaque references (§2.3) — this module never receives or stores plaintext file bytes, so it introduces no *new* at-rest encryption surface of its own beyond what the client-side upload already did. The existing `shared/crypto` (`CryptoService`/`IEncryptionPort`, ADR-009) is available if a future slice needs to encrypt any Module-05-owned sensitive field server-side. **Resolved as §20 Decision 10:** `doctorName`/`hospitalName` ship as plaintext columns in Slice 1 (optional, low-sensitivity structured metadata relative to the image itself) — revisit only if Compliance specifically flags them.
- **Access control:** every prescription read is checked against ownership (§2.2's Slice-1-scoped policy) **and logged** via `PrescriptionAccessLog`, both allow and deny outcomes, per `00-shared-conventions.md` §3.
- **Privacy denials:** generic `403` on unauthorized prescription access, no existence leakage (§10.4 errors list; `00-shared-conventions.md` §1).
- **No malware scanning in Slice 1** (§2.3) — a real, accepted risk carried forward from the "no upload infra exists" constraint. This module trusts that whatever external upload path the client used performed its own validation; **Module 05 does not process the file bytes at all**, so a malicious file cannot be executed or parsed by this backend (the risk is entirely in whatever system eventually *serves* `fileRef` to a pharmacist's browser — outside this module's boundary until Slice 2 builds real storage).
- **RBAC least privilege:** `prescription:verify` is a narrow, action-specific permission (not bundled into a broader `pharmacy:manage:org`) so a pharmacy owner/manager cannot silently self-approve prescriptions without being separately granted the `PHARMACIST` role — consistent with `00-shared-conventions.md` §9's separation-of-duties principle, and mirrors the self-review guard already proven in Module 01's `VerificationRequest`.
- **Health-data scope:** this is the **first module with genuinely clinical/health-sensitive data** (Modules 01–04 are identity/commercial, not clinical) — the stricter `00-shared-conventions.md` §3/§4 rules ("never log clinical content", "`BeneficiaryAccessPolicy`") are the authoritative constraint set here, even though §2.2 documents that the beneficiary half of that policy can't be built yet. **Explicit classification decision:** `Prescription` (all fields), `PrescriptionLine`, `VerificationReview`, and `DispenseRecord` are treated as **health-sensitive data** for every purpose `00-shared-conventions.md` §3/§4 define that term — access-policy-gated, access-logged (allow *and* deny), excluded from ordinary application logs, and excluded from domain-event payloads beyond bare identifiers (§11 review, confirmed against §9's event table: no event payload above carries `fileRef`, `doctorName`, `hospitalName`, or any line's `rawText`/quantities beyond what a consumer legitimately needs — `PrescriptionApproved`'s `lines` array carries `catalogProductId`/`approvedQuantity` only, which are commercial, not clinical, facts). This classification is not weakened anywhere in this document to avoid the Module 02/storage dependencies documented in §2.2/§2.3 — the narrower access-control *scope* (owner-only, §2.2) is a scope reduction, not a sensitivity reduction; every access within that narrower scope is still fully audited and access-logged.

---

## 15. Error Codes

### 15.1 [RESOLVED, review finding] Error codes are NOT freely definable strings — they must be appended to a real, shared, append-only enum
The first draft of this spec listed error codes as if they were ad-hoc per-module strings. **They are not.** `backend/src/shared/errors/error-codes.ts` defines a single, shared, append-only `ErrorCode` enum plus an `ERROR_HTTP_STATUS: Record<ErrorCode, number>` mapping — every prior module (01, 02, 03, 04) appended its own block of codes to this **one file**, each under a comment banner ("Module NN — ..., appended per the Phase-0 freeze exception"), with an explicit HTTP status entry for each. Some cross-cutting codes Module 05 needs **already exist** and must be reused, not reinvented: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONFLICT` (409), `RBAC_FORBIDDEN` (403), `BUSINESS_RULE_VIOLATION` (422), `IDEMPOTENCY_CONFLICT` (409) — this last one is directly relevant to §6.3/§8.1's dispense-replay design and should be reused for a genuinely conflicting (not identical-replay) idempotency-key reuse, rather than inventing a new code. **Note also:** `00-shared-conventions.md` §16's illustrative baseline list (`INVALID_STATE_TRANSITION`, `IDEMPOTENT_REPLAY`, etc.) does not exactly match the real enum's names (`IDEMPOTENCY_CONFLICT`, no `INVALID_STATE_TRANSITION` at all) — a pre-existing, minor architecture-doc-vs-code drift, flagged here for completeness but out of scope to fix in this review (it doesn't block Module 05, which grounds its own codes in the real enum, not the illustrative doc list).

### 15.2 Required shared-code change (category: production-code change, alongside — not before — Module 05's own implementation PR, same as every prior module)
Append the following block to `ErrorCode` and `ERROR_HTTP_STATUS` in `shared/errors/error-codes.ts` as part of Module 05's implementation PR (not a separate prerequisite PR — this is exactly how Modules 01/02/03/04 each did it, in their own PR, not ahead of it):

| New `ErrorCode` member | HTTP status | Used by |
| --- | --- | --- |
| `PRESCRIPTION_NOT_FOUND` | 404 | `GET/POST /prescriptions/:id`, verification, gate, dispense |
| `PRESCRIPTION_EXPIRED` | 422 | Gate, dispense (§3.11.4/§8.1) |
| `PRESCRIPTION_NOT_APPROVED` | 422 | Gate (no usable line) |
| `PRESCRIPTION_EXHAUSTED` | 409 | Dispense (§8.1 step 4) |
| `RX_REQUIRED` | 422 | Gate block reason (FR-MED-10) |
| `REJECTION_REASON_REQUIRED` | 422 | `RejectPrescriptionCommand` (BRULE-14, §3.11.2) |
| `VERIFICATION_FORBIDDEN` | 403 | Wrong-pharmacy/self-review reviewer (§5.2, §3.9 `VerificationPolicy`) |
| `INVALID_PRESCRIPTION_STATE_TRANSITION` | 409 | Concurrent approve/reject race on a `Prescription` (mirrors Module 03's own `INVALID_PRODUCT_STATUS_TRANSITION` precedent — a module-specific name, not the generic, nonexistent `INVALID_STATE_TRANSITION`) |
| `INVALID_MATCH_STATE_TRANSITION` | 409 | Invalid `MatchRequest` transition (e.g. selecting/re-matching a `FAILED` request) — a separate code from the prescription one, one per aggregate |
| `NO_PHARMACY_MATCH` | 409 | `FindMatch`/`Rematch` exhausted (§0.1, §16 edge case 4) |
| `MATCH_CANDIDATE_UNAVAILABLE` | 409 | `SelectMatch` on a candidate that's gone stale |
| `MATCH_FAILED` | 409 | Terminal `MatchRequest.status = FAILED` |

Reused, **not** redefined: `VALIDATION_ERROR` (400, DTO failures), `NOT_FOUND` (404, generic fallback), `CONFLICT` (409, generic retry-exhaustion fallback per §8.1 step 10), `RBAC_FORBIDDEN` (403, permission-guard failures), `IDEMPOTENCY_CONFLICT` (409, a genuine idempotency-key collision with *different* input, distinct from a same-input replay which returns `200`/`201` per §6.3), `CATALOG_PRODUCT_NOT_FOUND` (404, already defined under Module 04's block — Module 05 reuses it rather than redefining, since it means the exact same thing: `ICatalogPort.getProduct()` returned null/non-`ACTIVE`).

**`BENEFICIARY_ACCESS_DENIED`** — **not added in Slice 1.** The first draft proposed seeding this ahead of the feature (mirroring `catalog:read:any`); this review reverses that call — `00-shared-conventions.md` §16's own baseline already lists a generic `BENEFICIARY_ACCESS_DENIED`, so when Module 02 Slice 2/4 lands and Module 05 Slice 2 widens access (§2.2/§20 Decision 4), that shared baseline code is reused rather than Module 05 pre-emptively adding a module-specific one that might not match the eventual shape. Category: **future/deferred decision.**

Privacy denials on prescriptions return **generic `403` (`RBAC_FORBIDDEN` or a bare `FORBIDDEN`, never a distinguishing code)** without leaking existence, per `00-shared-conventions.md` §1 "privacy denials return generic 403" — confirmed consistent with how Module 01's `VerificationRequest`/Module 02's `Address` ownership checks already behave.

---

## 16. Edge Cases

| # | Scenario | Expected behavior |
| --- | --- | --- |
| 1 | Customer uploads a prescription, never gets matched to any pharmacy (abandons cart) | Prescription stays `UPLOADED` indefinitely — no sweeper cleans this up in Slice 1 (§8.4); it simply appears in `GET /prescriptions` as `UPLOADED`. Acceptable for Slice 1; retention/purge policy (§20 Q2) will eventually apply regardless of status. |
| 2 | Two pharmacists at the same pharmacy try to approve the same prescription concurrently | Under `Serializable` isolation (§8.1/§2.1.1), one transaction commits and the other either sees `status ≠ PENDING_VERIFICATION` on its (fresh, in-transaction) re-read → `409 INVALID_PRESCRIPTION_STATE_TRANSITION`, or is aborted by Postgres as a write-conflict and retried by the bounded-retry wrapper against the now-committed state, landing on the same `409` — never a double-approval, and never a raw `500`. |
| 8 | Two concurrent `DispenseMedicine` calls for the last unit of `remainingDispensable` (distinct `idempotencyKey`s, both logically legitimate) | Exactly one commits under `Serializable` isolation; the other is aborted as a write-conflict, retried against the now-`0`-remaining state, and correctly resolves to `409 PRESCRIPTION_EXHAUSTED` on retry — mirrors Module 04's "last unit" reservation race outcome, achieved via isolation level instead of a row lock (§8.1). |
| 9 | A `DispenseMedicine` call is retried by the caller (e.g. Module 06 fulfillment worker after a network timeout) with the **same** `idempotencyKey` | The `@@unique([prescriptionLineId, idempotencyKey])` constraint (§6.3) is hit; the command treats this as a replay and returns the original `DispenseRecord`'s id, not an error — `remainingDispensable` is decremented exactly once regardless of how many times the retry occurs. |
| 10 | A fully-dispensed, single-use prescription line reaches `remainingDispensable = 0` | The parent `Prescription.status → CONSUMED` (§6.2/§8.1 step 7) — visibly terminal in `GET /prescriptions`, distinct from a still-`APPROVED`-but-not-yet-exhausted prescription. |
| 11 | Five consecutive `Serializable` write-conflicts occur on the same `PrescriptionLine` under pathological contention | The bounded-retry wrapper exhausts `TRANSACTION_RETRY_MAX_ATTEMPTS = 5` and returns a deterministic `409 CONFLICT` — never an unhandled `500` (mirrors Module 03's `runWithDedupRetry` exhaustion contract exactly, §8.1 step 10). |
| 3 | Pharmacist approves with a `catalogProductId` that is valid but the product is `CONTROLLED`/`PROHIBITED` for online sale | Slice 1 does **not** re-run Module 03's `onlineSaleProhibited` check at approval time (only Module 04's `CreateListingCommand` does, at listing time) — a controlled substance can be *approved* on a prescription even if no pharmacy could ever have listed it for online sale, since the two checks serve different purposes (clinical approval vs. commercial listing eligibility). Flagged as a design note, not a bug — the Rx gate's job is "is this dispensable against an approved Rx," not "is this legal to sell online," which Module 04 already gates independently. |
| 4 | Match candidates found, customer never calls `/select` | `MatchRequest` stays `PENDING` — no reservation was ever made (reserve only happens in `SelectMatchCommand`), so no stock is held hostage. Self-cleaning by construction. |
| 5 | `RematchCommand` called on a `MATCHED` (not `REMATCHING`) request | Allowed — transitions `MATCHED → REMATCHING` internally before re-ranking; this is the "pharmacy declined" entry point, not a distinct pre-state the caller must set up first. |
| 6 | Dispense requested for a quantity exceeding `remainingDispensable` in one call (not cumulative) | Rejected outright (`409 PRESCRIPTION_EXHAUSTED`) — never partially dispensed and partially rejected within one call; the caller (Module 06/08) is responsible for splitting across multiple dispense calls if that's ever a real fulfillment shape (not modeled in Slice 1). |
| 7 | `beneficiaryId` supplied but does not correspond to any real Module 02 beneficiary (since none exist yet) | Accepted as opaque data (§2.2) — no validation against Module 02 is performed in Slice 1; this is intentional, not a missed check. |

---

## 17. Acceptance Criteria (representative, Given/When/Then)

1. **Given** a customer with no prior prescriptions, **when** they `POST /prescriptions` with a valid `fileRef`, **then** a `Prescription(UPLOADED)` row is created and `PrescriptionUploaded` is emitted.
2. **Given** a `PENDING_VERIFICATION` prescription at pharmacy P, **when** a `PHARMACIST` at P calls `.../reject` without a `reason`, **then** the request is rejected `422 VALIDATION_ERROR` (DTO) and, if a reason of only whitespace is somehow passed through, `REJECTION_REASON_REQUIRED` at the command layer — no `VerificationReview` or status change is persisted either way.
3. **Given** an `APPROVED`, single-use prescription line with `remainingDispensable = 5`, **when** `DispenseMedicine` is called with a fresh `idempotencyKey` for `quantity = 5` then again (different key) for `quantity = 1`, **then** the first succeeds, `remainingDispensable → 0` and the parent `Prescription.status → CONSUMED` (§6.2/§20 Decision 8), and the second fails `409 PRESCRIPTION_EXHAUSTED` with no `DispenseRecord` written for the second call.
4. **Given** a cart with one Rx item and no approved prescription line for it, **when** `ICheckRxGatePort.check()` is called, **then** `allowed = false` and `blocked` contains `{ catalogProductId, reason: 'RX_REQUIRED' }`.
5. **Given** two pharmacies both stock all requested lines, **when** `FindMatch` runs with a delivery location closer to pharmacy B, **then** pharmacy B ranks first regardless of price (distance-dominant, FR-MATCH-02).
6. **Given** a `MatchRequest` with a selected pharmacy that then has its reservation released via `Rematch`, **when** re-ranking finds no other full-coverage candidate, **then** `MatchRequest.status → FAILED` and `MatchFailed` is emitted — no partial/split candidate is silently offered (§0.2).
7. **Given** a successful `DispenseMedicine` call with `idempotencyKey = K`, **when** the identical call (`prescriptionLineId`, `K`) is retried, **then** the second call returns the **same** `dispenseRecordId` as the first, `remainingDispensable` is decremented exactly once, and no second `DispenseRecord`/audit/outbox row is written (§6.3/§20 Decision 7).

---

## 18. Testing Strategy & E2E Strategy & Definition of Done

Per `00-implementation-roadmap.md` §5 ("Testing strategy (per module, gate for DoD)") and mirroring the exact suite shape Modules 02/03/04 already established (`backend/test/<module>/*.e2e-spec.ts`, real Postgres via Testcontainers/Docker, same harness in `test/support/`).

### 18.1 Unit tests (domain, no DB)
- `PrescriptionGate` — allow/block matrix: OTC always allowed; Rx with no approved line blocked (`RX_REQUIRED`); Rx with expired line blocked (`PRESCRIPTION_EXPIRED`); Rx with exhausted line blocked (`PRESCRIPTION_EXHAUSTED`); Rx with sufficient `remainingDispensable` allowed.
- `DispensingPolicy` — exact-remaining, over-remaining, expired-prescription cases; exact-remaining case also asserts the `CONSUMED` cascade decision (§6.2/§8.1 step 7) when combined with `isSingleUse = true`.
- `MatchRankingStrategy` — distance dominance over price (fixed candidate fixtures, no geo/DB); tie-breaking; empty-candidate → empty ranked list (not an error at this layer — `NO_PHARMACY_MATCH` is an application-layer decision); no rating term present in the scoring function at all (§0.2 — a regression test asserting the function's arity/shape has no rating input, so a future careless addition doesn't silently start scoring against always-null data).
- `VerificationPolicy` — self-review rejection; wrong-pharmacy reviewer rejection; correct `PHARMACIST`-at-pharmacy approval.
- `RemainingDispensable`, `RejectionReason`, `ValidityPeriod` value-object construction/validation edge cases.
- **`isRetryableTransactionConflict`/`runWithMatchRetry`** (own copy of Module 03's `dedup-conflict.ts` pattern, §2.1.1/ADR-013) — unit-tested exactly like `modules/catalog/application/support/dedup-conflict.ts` has no dedicated spec file today (a gap in Module 03 itself, not repeated here): recognizes `P2034`/`40001`/`40P01`, retries up to 5 attempts, exhausts to a deterministic error, does not swallow unrelated errors.

### 18.2 Application/use-case tests (ports mocked)
- Each command (`UploadPrescription`, `ApprovePrescription`, `RejectPrescription`, `RequestClarification`, `DispenseMedicine`, `FindMatch`, `SelectMatch`, `Rematch`) — happy path + each documented error, asserting the correct events are queued via a mocked `OutboxService`/`IUnitOfWork`, same style as `backend/src/modules/pharmacy-inventory/application/commands/*.spec.ts`. `DispenseMedicineCommand`'s test suite explicitly includes a replay case (same `idempotencyKey` twice against a mocked repository) asserting no second `OutboxService.write()` call.

### 18.3 Integration/E2E tests (`test/prescription-matching/*.e2e-spec.ts`, real Postgres via Testcontainers/Docker, same harness as `test/pharmacy-inventory/*`)
| File | Scenarios |
| --- | --- |
| `upload-and-lifecycle.e2e-spec.ts` | Upload → appears in `GET /prescriptions`; reupload after clarification request; access log written on every `GET /:id` (allow case). |
| `verification-workflow.e2e-spec.ts` | Approve happy path (lines created with correct `remainingDispensable`); reject without reason → `422`; reject with reason → `PrescriptionRejected` outbox row; clarify → status transition; wrong-pharmacy pharmacist → `403 VERIFICATION_FORBIDDEN`; self-review attempt (uploader also holds `PHARMACIST` somewhere) → `403`; **concurrent** approve/reject race on the same prescription (§16 edge case 2) → exactly one wins, the other gets `409 INVALID_PRESCRIPTION_STATE_TRANSITION`, never a double-decision. |
| `access-control.e2e-spec.ts` | Cross-customer isolation (customer A cannot read customer B's prescription); cross-pharmacy isolation (pharmacist at pharmacy X cannot see pharmacy Y's queue); unauthenticated → `401`; missing-permission role → `403 RBAC_FORBIDDEN`; every denied read produces a `PrescriptionAccessLog(outcome=DENY)` row (the "logged" half of `00-shared-conventions.md` §3, not just the guard rejection). |
| `dispense-concurrency.e2e-spec.ts` | Sequential dispense down to exactly 0 remaining, cascading `Prescription.status → CONSUMED` on the final call (§6.2); a dispense attempt beyond remaining rejected with no ledger row; **concurrent** `Promise.allSettled` dispense race for the last unit of `remainingDispensable` under `Serializable` isolation (§8.1, §16 edge case 8) — exactly one succeeds, the loser is retried against committed state and correctly resolves to `409 PRESCRIPTION_EXHAUSTED`, mirroring Module 04's `reservation-concurrency.e2e-spec.ts` "last unit" outcome via a different mechanism; **idempotent replay** with a repeated `idempotencyKey` (§16 edge case 9) returns the original record, decrements exactly once; **retry-exhaustion** path forced via a test double that always raises `P2034` → deterministic `409 CONFLICT` after 5 attempts, never `500` (§16 edge case 11); reconciliation assertion `Σ(dispense_records.quantity) === line.dispensedQuantity` after every mutating flow, mirroring Module 04's `reconcile()` helper. |
| `rx-gate.e2e-spec.ts` | OTC passes; Rx with no prescription blocked; Rx with expired prescription blocked; Rx with exhausted prescription blocked; Rx with sufficient approved line passes and returns the correct `usablePrescriptionLineIds`. |
| `matching-ranking.e2e-spec.ts` | Real availability data seeded across ≥2 pharmacies via Module 04's actual `IInventoryPort`/listing-creation flow (not mocked — same "real, not mocked, cross-module call" discipline as Module 04's own `dedup-catalog-integration.e2e-spec.ts`); distance-first ranking verified against real haversine output from Module 04's `GetAvailabilityQuery`; override via explicit `pharmacyId` in `/select`; `NO_PHARMACY_MATCH` when no candidate covers all lines. |
| `rematch.e2e-spec.ts` | Select → rematch releases the prior reservation (verified via Module 04's `stock_reservations.status = RELEASED`) → excludes the declined pharmacy → picks next best; exhausting all candidates → `FAILED` + `MatchFailed` event; **cross-module seam ordering** (§12, ADR-014) explicitly asserted — `IInventoryPort.reserve()` is called and observably succeeds before `MatchRequest.status` flips to `MATCHED`, verified by inspecting the reservation row mid-flow via a test hook. |
| `atomicity.e2e-spec.ts` | **Required, not optional** (per this review's §7 instruction) — mirrors Modules 02/03/04's poisoned-outbox pattern exactly: a `PoisonedOutboxService` armed to throw once, forcing a mid-transaction failure on `UploadPrescriptionCommand`, `ApprovePrescriptionCommand`, `RejectPrescriptionCommand`, and `DispenseMedicineCommand`; asserts **no partial state** for each — no `Prescription`/`PrescriptionLine`/`VerificationReview`/`DispenseRecord`/cache-column change survives, no orphaned audit or outbox row, exactly the "state change + audit + outbox roll back together" guarantee this review's §7 instruction requires proven, not assumed. |
| `event-contracts.e2e-spec.ts` | Every event in §9 fires with the exact payload shape contracted in `00-domain-event-catalog.md`, mirroring Module 04's `event-contracts.e2e-spec.ts`. |

### 18.4 Regression requirement
Modules 01–04's existing unit + e2e suites (68 unit suites/369 tests, 30 e2e suites/178 tests as of the last full run) **must remain green** throughout Module 05's implementation — Module 05 adds a new module folder and appends to two shared files (`shared/errors/error-codes.ts` §15.2, `prisma/rbac-catalog.ts` §7.2) but must not edit any existing Module 01–04 source file's behavior. CI (or the implementer, pre-merge) must run `npm run test` and `npm run test:e2e` for the full monolith, not just the new module's suites, before Module 05 is considered mergeable.

### 18.5 Definition of done
Matches §0.3, plus: unit + application + integration/E2E suites above all green against a real Postgres instance (Testcontainers/Docker, per existing `test/support/test-database.ts`); §18.4's regression requirement holds; no test weakened or deleted to pass (`00-implementation-roadmap.md` §5); every emitted event contract-tested; the dispense-ledger reconciliation invariant (§3.11.3/§18.3) and the audit-chain-safety invariant (§2.1.1/ADR-013) each have a dedicated passing test, not just incidental coverage; the two required schema changes (§6.2/§6.3) are applied and validated (`prisma validate`) before any of the above can run.

---

## 19. Dependencies & Vertical Slice Plan

| Depends on | What's needed | Status |
| --- | --- | --- |
| Module 01 — Identity | `JwtAuthGuard`/`PermissionsGuard` (global), `AuditService`, error envelope, `user_roles`/`roles` read for `IIdentityPort` | ✅ Implemented |
| Module 02 — Profiles | `CustomerProfile` (not actually needed — this module reads `User`/RBAC via Module 01, not `CustomerProfile`); `Beneficiary` + `BeneficiaryAccessPolicy` | ⚠️ Not yet implemented — worked around per §2.2 |
| Module 03 — Catalog | `ICatalogPort.getProduct()` | ✅ Implemented |
| Module 04 — Pharmacy/Inventory | `GET /availability/product/:id`, `IInventoryPort` (reserve/confirm/release/dispatch) | ✅ Implemented |
| Module 06 — Orders | Consumer of `ICheckRxGatePort`/`IDispensingPort`/matching APIs; owns the checkout saga that actually sequences match → verify → pay → dispense | ❌ Not yet built (next module in the roadmap) — Module 05 Slice 1 is buildable and testable **standalone** (its own e2e suite exercises the ports/commands directly, exactly as Module 04's Slice 1 did before Module 06 existed) |
| Module 13 — Notifications | `INotificationPort` for approval/rejection/match-failure notices | ✅ Implemented (Phase 0) |
| Module 15 — Reviews | Rating input to `MatchRankingStrategy` | ❌ Not yet built (Phase 3) — ranking ships distance/price-only (§0.2) |

**Vertical slice plan:** Slice 1 (this document) → Slice 2 (beneficiary-scoped access once Module 02 Slice 2/4 lands; split fulfillment once Module 06 decides; substitute dispensing once Module 03 Slice 2 lands; real `IStoragePort`/malware-scan once a shared storage port is built; rating term once Module 15 lands) → Slice 3 (AI-assisted OCR pre-fill, queue SLA/partitioning at scale).

---

## 20. Architect Review — Resolved Decisions (v2, supersedes the v1 "Open Questions" list)

This section was originally titled "Open Architecture Questions" and left all 12 items unresolved. Following a full architecture review cross-checking every assumption against the actual implemented code (Modules 01–04, `shared/`, `prisma/schema/`, `prisma/rbac-catalog.ts`), **all 12 items now have a concrete decision.** Each is tagged with its resolution category per this review's taxonomy: **[Doc]** documentation only, **[Slice]** requires a prerequisite module/slice, **[ADR]** requires (and now has) an ADR, **[Code]** requires a production-code/schema change before or alongside Module 05, **[Deferred]** a genuine future/deferred decision that does not block Slice 1.

1. **File upload infrastructure ownership. [Doc]** Confirmed by repository-wide search: `IStoragePort`/`IMalwareScanPort`/`IKmsPort` do not exist anywhere in `backend/src`; no MinIO/S3 client code exists in `backend/src` or `backend/package.json` (the running `docker-minio-1` container in the dev environment is unused by any current module — infrastructure provisioned ahead of a consumer, not yet wired to anything). Module 01's `VerificationRequest.documents[].storageRef` already establishes the precedent of accepting an opaque, pre-uploaded reference. **Decision:** Module 05 Slice 1 accepts a pre-uploaded `fileRef` (§2.3, §5.1) — this is safe, precedent-backed, and does not block implementation. **Recommendation (non-blocking):** a future, small, cross-cutting spec for a shared `shared/storage/` port, since Module 02 (photo upload), Module 11 (diagnostic results), and Module 12 (consult recordings) will all hit this identical wall — worth solving once. Not a Module 05 prerequisite.
2. **Prescription validity/retention period. [Deferred]** No regulatory answer exists in any document reviewed. **Decision:** implement `retentionUntil = now + IConfigPort.get('prescription.retentionYears', default: 5)` (module-namespaced config key, `00-shared-conventions.md` §10 convention) — a conservative, config-adjustable placeholder that does not block coding and can be corrected via config with no redeploy once Compliance confirms the real number (NFR-MAINT-03). The **exact number** remains a genuine open product/compliance question, tracked separately from implementation readiness.
3. **Individual pharmacist licensing. [Doc for Slice 1] + [Slice, deferred for Module 01].** Confirmed: `VerificationType` enum (`prisma/schema/01-identity.prisma`) has `FAYDA | PHARMACY_LICENSE | DRIVER_DOCS | DOCTOR_LICENSE` — no `PHARMACIST_LICENSE`, even though the analogous `DOCTOR_LICENSE` exists. **Decision:** accept RBAC role membership (`PHARMACIST` role at the verifying pharmacy's organization, checked via Module 05's own `IIdentityPort.hasRoleAtOrganization()`, §2.1) as the Slice 1 proxy for "licensed pharmacist" — this is an explicit, documented scope narrowing (a real compliance gap), not a silent assumption. **Recommend** Module 01 add `PHARMACIST_LICENSE` and a verification flow in a future, separate slice (§6.5) — not a Module 05 prerequisite, since it is Identity's schema/ownership and Module 05 cannot itself close an Identity-side credentialing gap.
4. **Beneficiary access widening timeline. [Doc for Slice 1] + [Slice for widening].** Confirmed via grep: no `Beneficiary` model, no `BeneficiaryAccessPolicy` anywhere under `backend/src/modules/profiles`. `backend/docs/02-profiles-spec.md` §1.2 explicitly defers both to Module 02's own Slice 2/4. **Decision:** Slice 1 ships owner-only access (§2.2) — safe, because it is a strict *subset* of the eventually-intended access surface (an additive widening later can only grant more access, never revoke access already granted, so no security regression is introduced by shipping the narrower policy first). Widening happens in **Module 05 — Slice 2**, triggered by and coordinated with Module 02 Slice 2/4's completion — not before, and not guessed at now.
5. **Expiry sweeper for UX. [Doc]** **Decision:** no cron sweeper. Instead, `GetPrescription`/`ListPrescriptions` compute a **derived, non-persisted** `displayStatus` at query time (`EXPIRED` if `expiryDate` is in the past and stored `status` is not already a terminal state, else the stored `status`) — this closes the UX gap (a customer never sees a stale "Approved" badge on an actually-expired prescription) with zero new schema, zero new cron job, and zero change to the authoritative `status` column that gate/dispense logic (§3.11.4) already checks live. Added to §10.1's `GET /prescriptions`/`GET /prescriptions/:id` response shape.
6. **`AssignVerifyingPharmacyCommand` trigger point. [Doc now; Slice for final confirmation]** **Decision:** Module 05 Slice 1 defines and implements `AssignVerifyingPharmacyCommand`/exposes it as an internal port method (§4, §11) **now**, callable directly (its own e2e suite exercises it directly, exactly as Module 04's `IInventoryPort` was tested before Module 06 existed). The **exact point in Module 06's future checkout saga** that calls it is necessarily a Module 06 design decision this document cannot finalize alone — flagged for joint sign-off when Module 06's spec is drafted, but this does **not** block Module 05 Slice 1's own implementation or testability.
7. **Dispense idempotency key shape and mechanism. [Code — required, §6.3]** **Decision:** client/caller-supplied `idempotencyKey: string`, enforced by a **database-level** `@@unique([prescriptionLineId, idempotencyKey])` constraint on `dispense_records` (preferred over an application-only check per this review's instruction to favor DB-enforced invariants), checked inside the same `Serializable` transaction as the dispense write (§8.1). This is a **required schema change**, not a documentation-only resolution — see §6.3/§6.6.
8. **Missing `CONSUMED` status value. [Code — required, §6.2]** Confirmed: the actual Prisma `PrescriptionStatus` enum lacks `CONSUMED`, which the parent architecture doc's §5.2 names as a real status value. This is genuine code/doc drift, not a misreading. **Decision:** add `CONSUMED` to the enum (additive, safe per ADR-003/event-catalog rule 1) — **required schema change** before implementation, since the dispensing invariant (§3.11.3/§8.1 step 7) depends on a real terminal state. See §6.2/§6.6.
9. **Cross-module "distributed transaction" seam in `SelectMatchCommand`/`RematchCommand`. [ADR — now resolved, ADR-014]** **Decision:** accept the eventual-consistency seam as a **named, platform-wide pattern**, not a one-off Module 05 risk — formalized as **ADR-014** (`00-decision-log.md`, added by this review) with a concrete, non-arbitrary resolution: call the Module 04 port operation (`reserve`/`release`) **first**, update Module 05's own `MatchRequest` state **second**, so the only possible orphan (reservation succeeds, bookkeeping update fails) self-heals via Module 04's existing TTL sweeper (ADR-007) — the reverse ordering would produce a non-self-healing orphan and was rejected. Building a real saga now, ahead of Module 06's `CheckoutSaga` existing, was explicitly rejected as premature machinery (consistent with §0.2's "no speculative machinery" principle applied elsewhere in this document). Not a blocker.
10. **Field-level encryption for `doctorName`/`hospitalName`. [Deferred]** **Decision:** ship as plaintext columns in Slice 1 — they are optional, low-sensitivity structured metadata relative to the prescription image itself (which is already out of this module's custody per §2.3), and `shared/crypto`'s envelope-encryption overhead is not justified for this narrow a field set without a specific compliance requirement demanding it. Revisit if/when Compliance flags these fields specifically (tracked, not blocking).
11. **Split fulfillment at launch (FR-MATCH-07). [Slice, deferred to Module 06]** Reconfirmed: still an open **product** decision at the `00-architecture-index.md` level, owned by Module 06, not Module 05. Slice 1 ships single-pharmacy-only regardless of the eventual answer (§0.2) — does not block Module 05 implementation.
12. **Substitute dispensing (BRULE-16). [Slice, deferred to Module 03 Slice 2]** Reconfirmed: blocked on `EquivalenceGroup`'s substitution *feature* (not just its schema, which already exists) landing in Module 03 — Slice 1 ships without it by design (§0.2), not by oversight. Does not block Module 05 Slice 1 implementation.

### 20.1 Additional decisions surfaced by this review (beyond the original 12)
13. **Transaction isolation level. [ADR — now resolved, ADR-013]** The v1 draft implicitly copied Module 04's `Read Committed`+`FOR UPDATE` pattern for the dispense flow. This review found that pattern **unsafe for a module whose commands also call `AuditService.record(..., tx)` in the same transaction** (confirmed: Module 04 itself does this in ≥10 commands, at `Read Committed`, which per `AuditService`'s own doc comment risks a silent audit-hash-chain fork under true concurrency — flagged as a pre-existing gap in already-shipped Module 04 code, out of scope to fix here). **Decision:** Module 05 follows Modules 02/03's proven `Serializable` + bounded-retry (5 attempts) pattern for every mutating command, formalized as **ADR-013**. See §2.1.1, §8, §12.
14. **`ErrorCode` enum extension. [Code — required, alongside Module 05's implementation PR, §15]** The v1 draft treated error codes as freely-definable strings. They are not — `shared/errors/error-codes.ts` is a single, shared, append-only enum with an HTTP-status map that every prior module extended in its own PR. §15.2 now specifies the exact block Module 05 must append, reusing existing generic codes (`VALIDATION_ERROR`, `RBAC_FORBIDDEN`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CATALOG_PRODUCT_NOT_FOUND`) where they already mean the right thing, rather than reinventing them. This is normal, expected, in-PR work (like Modules 01–04 each did), not a prerequisite blocker.

---

## Final Sign-Off Checklist

| Gate | Status |
| --- | --- |
| All 12 originally-open questions resolved with a concrete decision | ✅ (§20) |
| No unresolved dependency silently assumed away | ✅ — every real gap (Beneficiary, storage, `PHARMACIST_LICENSE`) is documented with an explicit, safe, additive workaround, not invented infrastructure |
| API contracts internally consistent | ✅ (§10, error codes reconciled against §15's real enum) |
| Database requirements clear | ✅ (§6) — but **two are REQUIRED, not optional** (§6.2, §6.3) |
| Security model clear | ✅ (§14) — health-sensitive classification made explicit (§14) |
| Transaction boundaries clear | ✅ (§8, §12) — corrected from the v1 draft's implicit Module-04-style pattern to the correct Module-02/03-style pattern (ADR-013) |
| Idempotency clear | ✅ (§6.3, §8.1) — mechanism specified precisely (DB-enforced unique constraint), not left as "a follow-up" |
| Event contracts clear | ✅ (§9) — unchanged from v1, already matched the catalog exactly |
| Testing/QA requirements complete | ✅ (§18) — unit/application/integration/E2E/security/concurrency/atomicity/regression all specified |
| **Required schema changes actually applied** | ❌ **NOT YET DONE** — §6.2 (`CONSUMED` enum value) and §6.3 (`dispense_records.idempotencyKey` + unique constraint) remain **proposed, not applied**, per this review's explicit instruction not to create migrations |

**Because the last row is not satisfied, this specification's status remains DRAFT — NOT READY FOR IMPLEMENTATION**, not because any open question remains, but because two small, precisely-specified, additive Prisma schema changes must land first. Once §6.2 and §6.3 are applied and `prisma validate`/`prisma format` pass, this document's own gate (this checklist) is satisfied and the status may be promoted to **READY FOR IMPLEMENTATION** without any further architectural review — everything else in this document is final.

---

**End of Module 05 — Slice 1 specification, v2 (architecture-reviewed).** Status: **DRAFT — NOT READY FOR IMPLEMENTATION**, blocked solely on §6.2/§6.3's two required Prisma schema changes (not on any unresolved design question — all 12 original questions plus 2 newly-discovered ones are resolved in §20). Recommended next step: apply the §6.6 migration summary table's required rows, run `prisma validate`, then begin implementation directly against this document with no further sign-off needed.
