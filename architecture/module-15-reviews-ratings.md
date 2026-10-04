# Module 15 — Reviews & Ratings (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 15 — Reviews & Ratings (Post-transaction ratings for pharmacies, doctors, providers, delivery)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity), 06 (Orders — verified purchase), 08 (Delivery), 10 (Appointments), 11 (Diagnostics). Consumed by: Search (14, rating signals), Pharmacy/Provider dashboards, Admin moderation.
**Traceability:** FR-REV-01..08, FR-PRV-12, FR-ADM-11, BRULE-45, BRULE-46, BRULE-47, NFR-AUDIT, NFR-PRIV

> Single source of truth for the Reviews & Ratings bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module captures **post-transaction feedback** — ratings and reviews for pharmacies, doctors, healthcare providers, and delivery — and computes the **aggregate rating signals** that power discovery ranking (Module 14), provider dashboards (FR-PRV-12), and trust across the marketplace.

**Core principle — verified-transaction reviews only.** A review can be submitted **only by a user who actually completed the relevant transaction** (a delivered order, a completed appointment, a finished delivery). This is the single most important rule (BRULE-45): it prevents fake/spam reviews and makes ratings trustworthy. Reviews are tied to a specific completed transaction, not just an entity.

**Polymorphic target, one engine.** Pharmacies, doctors, providers, and delivery drivers are all **rateable subjects** with the same review structure (score + comment + moderation + aggregate). Rather than four review systems, one `Review` aggregate with a **polymorphic `subject` (type + id)** handles all, keeping aggregation, moderation, and anti-abuse logic in one place.

**Primary objectives**
- Let users rate/review after a completed transaction (FR-REV-01/02, BRULE-45).
- Support **multi-dimension ratings** where useful (e.g., doctor: knowledge/communication/wait-time) (FR-REV-03).
- Compute and expose **aggregate ratings** per subject (avg + count + distribution) (FR-REV-04).
- Enable **subject responses** (pharmacy/doctor replies to a review) (FR-REV-05).
- **Moderate** reviews (report, hide, remove) for abuse/policy (FR-REV-06, FR-ADM-11, BRULE-46).
- Enforce **one review per transaction** and edit/delete windows (FR-REV-07, BRULE-47).
- Feed rating signals to Search/dashboards (FR-REV-08, FR-PRV-12).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-RV-01 | Only users who completed a transaction may review the related subject. | FR-REV-01, BRULE-45 |
| BR-RV-02 | Users rate pharmacies, doctors, providers, and delivery. | FR-REV-02 |
| BR-RV-03 | Reviews include a star score and optional comment. | FR-REV-02 |
| BR-RV-04 | Multi-dimensional ratings are supported where configured. | FR-REV-03 |
| BR-RV-05 | Aggregate ratings (avg, count, distribution) are computed and shown. | FR-REV-04 |
| BR-RV-06 | Subjects (pharmacy/doctor) may respond to reviews. | FR-REV-05 |
| BR-RV-07 | Reviews can be reported and moderated. | FR-REV-06, FR-ADM-11, BRULE-46 |
| BR-RV-08 | One review per completed transaction; edit/delete within policy window. | FR-REV-07, BRULE-47 |
| BR-RV-09 | Ratings feed discovery ranking and provider performance metrics. | FR-REV-08, FR-PRV-12 |
| BR-RV-10 | Reviews respect privacy (no health-sensitive detail exposure). | NFR-PRIV, BRULE-37 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Review Submission
- **F-RV-01** Submit a review for a completed transaction (order/appointment/delivery/diagnostic) → maps to subject (BRULE-45).
- **F-RV-02** Star rating (1–5) + optional text comment (FR-REV-02).
- **F-RV-03** Multi-dimensional sub-ratings per subject type (config): e.g., doctor {knowledge, communication, punctuality}; pharmacy {speed, packaging, accuracy}; delivery {timeliness, courtesy} (FR-REV-03).
- **F-RV-04** Optional photo attachment (moderated).
- **F-RV-05** One review per transaction; edit within window, delete within window (BRULE-47).

### 3.2 Aggregation & Display
- **F-AG-01** Compute per-subject aggregate: average, count, star distribution, per-dimension averages (FR-REV-04).
- **F-AG-02** Publish aggregate to subject's home module (denormalized `rating_avg`/`rating_count` on pharmacy/doctor/provider/driver) + Search (14).
- **F-AG-03** List reviews per subject (paginated, sortable: recent/helpful/rating).
- **F-AG-04** "Verified purchase/visit" badge on every review (always true given BRULE-45).
- **F-AG-05** Helpfulness voting (optional) for review sorting.

### 3.3 Responses & Moderation
- **F-MOD-01** Subject owner responds to a review (one response, editable) (FR-REV-05).
- **F-MOD-02** Any user reports a review (reason) → moderation queue (FR-REV-06).
- **F-MOD-03** Admin moderates: approve/hide/remove with reason; auto-flag via profanity/abuse rules (BRULE-46).
- **F-MOD-04** Review lifecycle: `PUBLISHED → (REPORTED) → HIDDEN/REMOVED`; author-deleted.
- **F-MOD-05** Author notified of moderation actions.

### 3.4 Signals
- **F-SG-01** Emit rating-changed events → Search (14) reindex + provider metrics (FR-PRV-12).
- **F-SG-02** Provider/pharmacy dashboards: rating trends, recent reviews, response rate.

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Integrity/Trust** | No fake reviews (BRULE-45) | Verified-transaction gate; one-per-transaction unique constraint. |
| **Consistency** | Accurate aggregates | Incremental aggregate update on review change; periodic recompute reconciliation. |
| **Performance** | Fast review lists + aggregates (NFR-PERF-01) | Denormalized aggregates; cached subject rating; paginated lists. |
| **Moderation/Safety** | Abuse handled (BRULE-46) | Report queue + auto-flag rules + admin actions; audit trail. |
| **Privacy** | No health-sensitive leakage (NFR-PRIV, BRULE-37) | Content policy; reviews about service quality, not clinical detail; PII-light. |
| **Auditability** | Moderation traced (NFR-AUDIT) | Hash-chained audit on moderation + responses. |
| **Fairness** | Balanced representation | Anti-spam (rate limits), one-per-transaction, helpfulness sorting. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Review** (aggregate root) — a single verified review: author, subject, transaction ref, scores, comment, status.
- **ReviewDimension** (value/entity) — a sub-rating (name + score) within a review.
- **ReviewResponse** (entity) — the subject owner's reply.
- **ReviewReport** (entity) — an abuse/policy report against a review.
- **RatingAggregate** (aggregate/projection) — per-subject rolled-up stats.

### 5.2 Value Objects
- `Subject` (SubjectType {PHARMACY|DOCTOR|PROVIDER|DELIVERY} + subjectId), `TransactionRef` (type + id — order/appointment/delivery/diagnostic), `StarScore` (1–5), `DimensionScore`, `ReviewStatus` (PUBLISHED|HIDDEN|REMOVED|DELETED), `ReportReason`, `ModerationDecision`.

### 5.3 Invariants (trust-critical)
- A `Review` **requires a valid, completed `TransactionRef`** owned by the author (BRULE-45) — verified via the source module before creation.
- **One review per (author, transaction, subject)** — unique constraint prevents duplicate/spam (BRULE-47).
- The subject of a review is **derived from the transaction** (e.g., the pharmacy that fulfilled the order; the doctor of the appointment) — a user can't review an arbitrary entity they didn't transact with.
- Edit/delete only within the **policy window**; after that, immutable for integrity (BRULE-47).
- Aggregates are **derived** from PUBLISHED reviews only — HIDDEN/REMOVED/DELETED excluded; recomputed on any status change.
- A `ReviewResponse` may be authored **only by the subject owner** (the reviewed pharmacy/doctor).
- Review content passes a **privacy/content policy** — service-quality feedback, not clinical/health detail (BRULE-37, NFR-PRIV).

**Design rationale — transaction-anchored reviews.** Anchoring every review to a specific completed transaction (not just a subject) is what makes ratings trustworthy (BRULE-45) and enforces one-per-transaction (BRULE-47) via a simple unique constraint. It also lets us derive the correct subject automatically (the actual fulfilling pharmacy/doctor), preventing misdirected or fabricated reviews.

---

## 6. Verified-Review Gate (BRULE-45)

Before a review is accepted, `VerifiedTransactionPolicy` confirms eligibility via the owning module's port:

| SubjectType | Transaction | Eligibility check (port) | Derived subject |
| --- | --- | --- | --- |
| PHARMACY | Order | Order `COMPLETED` & owned by author (Module 6) | fulfilling pharmacy |
| DELIVERY | Delivery job | Job `DELIVERED`/`COMPLETED` for author's order (Module 8) | assigned driver |
| DOCTOR | Appointment | Appointment `COMPLETED` & patient=author (Module 10) | the doctor |
| PROVIDER | Diagnostic booking | Booking `COMPLETED` & patient=author (Module 11) | the provider |

Only after the source module confirms completion + ownership does the review persist. This gate is the trust backbone.

**Design rationale.** Centralizing the eligibility check behind per-type ports keeps the rule uniform and lets each source module remain the authority on "did this transaction actually complete for this user" — Reviews never guesses.

---

## 7. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps; soft-delete/status for lifecycle.

**reviews** — aggregate root.
- `id`, `author_user_id` (FK), `subject_type` (PHARMACY|DOCTOR|PROVIDER|DELIVERY), `subject_id`, `transaction_type` (ORDER|APPOINTMENT|DELIVERY|DIAGNOSTIC), `transaction_id`, `score` (1–5), `comment` (nullable), `photo_ref` (nullable), `status` (PUBLISHED|HIDDEN|REMOVED|DELETED), `helpful_count`, `created_at`, `updated_at`, `edit_deadline`, `deleted_at`.
- **Unique (`author_user_id`,`transaction_type`,`transaction_id`,`subject_type`)** — one review per transaction (BRULE-47).
- Index (`subject_type`,`subject_id`,`status`,`created_at`).

**review_dimensions** — sub-ratings.
- `id`, `review_id` (FK), `dimension` (e.g., COMMUNICATION|SPEED|PACKAGING|TIMELINESS), `score` (1–5).

**review_responses** — subject owner replies.
- `id`, `review_id` (FK, unique), `responder_user_id` (FK), `body`, `created_at`, `updated_at`.

**review_reports** — abuse reports.
- `id`, `review_id` (FK), `reporter_user_id` (FK), `reason`, `details` (nullable), `status` (OPEN|REVIEWED|DISMISSED|ACTIONED), `created_at`, `reviewed_by` (nullable), `reviewed_at`.

**review_helpful_votes** — helpfulness.
- `id`, `review_id` (FK), `user_id` (FK), `created_at`. Unique (`review_id`,`user_id`).

**rating_aggregates** — per-subject rollup (projection).
- `subject_type`, `subject_id` (composite PK), `avg_score`, `review_count`, `distribution` (jsonb: {1..5 counts}), `dimension_averages` (jsonb), `updated_at`.

**Relationships**
- `reviews 1—N review_dimensions / review_reports / review_helpful_votes`; `reviews 1—1 review_responses`.
- `rating_aggregates` keyed by polymorphic subject.

**Rationale.** The unique constraint on the transaction tuple is the **enforcement mechanism for BRULE-45/47** at the DB level (defense in depth beyond the app gate). `rating_aggregates` is a denormalized projection incrementally updated on review status changes and periodically reconciled — fast reads for Search/dashboards without scanning all reviews.

---

## 8. API Design

Base paths: `/api/v1/reviews`, `/api/v1/subjects` (aggregate reads), `/api/v1/admin/reviews`. Bearer auth (reads mostly public). Envelope/errors per Module 1 §14.

### 8.1 Submission & Management (author)
- **GET `/reviews/pending`** — completed transactions awaiting review (prompts) (BRULE-45).
- **POST `/reviews`** — `{ transactionType, transactionId, score, dimensions?, comment?, photo? }` → verified gate → create. Errors: `TRANSACTION_NOT_ELIGIBLE`, `ALREADY_REVIEWED`.
- **PATCH `/reviews/{id}`** — edit within window (BRULE-47). Error: `EDIT_WINDOW_CLOSED`.
- **DELETE `/reviews/{id}`** — author delete within window.
- **GET `/reviews/mine`** — my reviews.

### 8.2 Aggregate & List Reads (public)
- **GET `/subjects/{type}/{id}/reviews`** — paginated list (sort: recent|helpful|rating).
- **GET `/subjects/{type}/{id}/rating`** — aggregate (avg, count, distribution, dimensions).
- **POST `/reviews/{id}/helpful`** — vote helpful (toggle).
- **POST `/reviews/{id}/report`** — `{ reason, details? }` → moderation queue (FR-REV-06).

### 8.3 Subject Owner Response (`review:respond:org|self`)
- **POST `/reviews/{id}/response`** — owner reply (one, editable) (FR-REV-05). Guard: caller owns the subject.

### 8.4 Admin Moderation (`review:moderate:any`)
- **GET `/admin/reviews/reports`** — report queue (+ auto-flagged).
- **POST `/admin/reviews/{id}/hide|remove|restore`** — `{ reason }` → status change (BRULE-46). Audited; author notified.
- **GET `/admin/reviews`** — search/filter reviews.

**Representative errors:** `TRANSACTION_NOT_ELIGIBLE` (BRULE-45), `ALREADY_REVIEWED` (BRULE-47), `EDIT_WINDOW_CLOSED`, `NOT_SUBJECT_OWNER` (response), `REVIEW_NOT_FOUND`, `CONTENT_POLICY_VIOLATION` (BRULE-46/37), `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 9. NestJS Folder Structure (Clean Architecture)

```
src/modules/reviews/
  domain/
    entities/            # Review, ReviewDimension, ReviewResponse, ReviewReport, RatingAggregate
    value-objects/       # Subject, TransactionRef, StarScore, DimensionScore, ReviewStatus,
    │                    # ReportReason, ModerationDecision
    events/              # ReviewPublished, ReviewEdited, ReviewRemoved, ReviewResponded,
    │                    # ReviewReported, RatingAggregateUpdated
    enums/               # SubjectType, TransactionType, ReviewStatus, ReportStatus
    repositories/        # IReviewRepository, IResponseRepository, IReportRepository, IAggregateRepository
    services/            # VerifiedTransactionPolicy, RatingAggregator, ContentPolicy (profanity/privacy),
    │                    # ModerationPolicy, DimensionConfig
  application/
    commands/            # SubmitReview, EditReview, DeleteReview, RespondToReview, ReportReview,
    │                    # VoteHelpful, ModerateReview, RecomputeAggregate
    queries/             # GetPendingReviews, ListSubjectReviews, GetSubjectRating, GetMyReviews, GetReportQueue
    ports/               # IOrderPort(6), IDeliveryPort(8), IAppointmentPort(10), IDiagnosticsPort(11),
    │                    # ISearchSignalPort(14), IProviderMetricsPort, INotificationPort, IAuditPort, ICachePort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/
    moderation/          # ProfanityFilterAdapter (auto-flag)
    ports-adapters/      # Order/Delivery/Appointment/Diagnostics/SearchSignal/ProviderMetrics/Notification
    scheduling/          # AggregateReconciler (periodic recompute), ReviewPromptScheduler
    cache/ audit/
  interface/
    http/
      controllers/       # ReviewController, SubjectRatingController, AdminReviewController
      dtos/ guards/       # SubjectOwnerGuard, PermissionsGuard
      decorators/ filters/ interceptors/  # AuditInterceptor on moderation
    events/              # on transaction COMPLETED (6/8/10/11) → prompt review;
    │                    # on ReviewPublished/Removed → RatingAggregator + ISearchSignalPort + metrics
  reviews.module.ts
```

**Rationale.** `VerifiedTransactionPolicy` (the BRULE-45 gate) and `RatingAggregator` are pure domain services. Source modules are reached only via ports for eligibility checks; rating changes emit to Search (14) and provider metrics via `ISearchSignalPort`/`IProviderMetricsPort`, closing the loop with ranking (Module 14) and dashboards (FR-PRV-12).

---

## 10. Sequence Flows

### 10.1 Submit Review (verified gate, BRULE-45/47)
```
Client → GET /reviews/pending → completed txns not yet reviewed
Client → POST /reviews {transactionType: ORDER, transactionId, score, dimensions, comment}
SubmitReview → VerifiedTransactionPolicy: IOrderPort.isCompletedFor(author, txnId)? else TRANSACTION_NOT_ELIGIBLE
SubmitReview → derive subject (fulfilling pharmacy)
SubmitReview → ContentPolicy: profanity/privacy scan → CONTENT_POLICY_VIOLATION or flag
SubmitReview → persist Review(PUBLISHED)  [unique(txn) → ALREADY_REVIEWED]
SubmitReview → RatingAggregator.apply(+score) → update rating_aggregates
SubmitReview → emit ReviewPublished → ISearchSignalPort (reindex rating) + IProviderMetricsPort
→ 201
```

### 10.2 Moderation (BRULE-46)
```
User → POST /reviews/{id}/report {reason}
ReportReview → create ReviewReport(OPEN); auto-flag if ContentPolicy severe
Admin → GET /admin/reviews/reports → queue
Admin → POST /admin/reviews/{id}/remove {reason}
ModerateReview → status REMOVED; RatingAggregator.apply(−score) (recompute)
ModerateReview → emit ReviewRemoved → Search/metrics update; notify author; IAuditPort
```

### 10.3 Owner Response (FR-REV-05)
```
PharmacyOwner → POST /reviews/{id}/response {body}
RespondToReview → SubjectOwnerGuard: caller owns subject? else NOT_SUBJECT_OWNER
RespondToReview → save ReviewResponse (one per review); notify reviewer
```

### 10.4 Aggregate Reconciliation
```
AggregateReconciler (scheduled) → per subject: recompute avg/count/distribution/dimension avgs
   from PUBLISHED reviews → correct any drift from incremental updates
 → publish to home module (rating_avg/count) + Search (14)
```

---

## 11. Error Handling

Reuses Module 1 §14. Trust rules are hard blocks: `TRANSACTION_NOT_ELIGIBLE` (no verified transaction, BRULE-45), `ALREADY_REVIEWED` (unique constraint, BRULE-47), `EDIT_WINDOW_CLOSED` (BRULE-47), `NOT_SUBJECT_OWNER`, `CONTENT_POLICY_VIOLATION` (profanity/privacy, BRULE-46/37). Aggregate updates are transactional with review status changes so displayed ratings never drift from published reviews.

---

## 12. Logging & Auditing

Reuses hash-chained `audit_logs`. **Must-log:** review submitted/edited/deleted (author), **moderation actions** (hide/remove/restore + reason + admin), owner responses, reports filed, auto-flag triggers, aggregate recomputations that change a subject's public rating materially. **Never expose/log** health-sensitive content; reviews are service-quality only (BRULE-37, NFR-PRIV). Report/moderation history retained for policy enforcement.

---

## 13. Future Scalability & Evolution

- **Aggregate scale** — incremental updates + periodic reconciliation; partition reviews by subject; cache hot subject ratings.
- **Richer trust signals** — weight recent reviews, reviewer credibility, verified-purchase weighting; surface to Search ranking (14).
- **AI moderation (future)** — ML toxicity/spam/fake-pattern detection behind `ContentPolicy`/`ModerationPolicy` ports; human admin stays final arbiter.
- **Sentiment & insights** — aggregate review text into provider-facing insights (FR-PRV-12) without exposing raw sensitive content.
- **Response SLAs & incentives** — track response rate; nudge providers to reply.
- **Extraction-ready** — depends on transaction modules only via ports and emits rating events; a clean standalone Reviews service feeding a ratings projection.

---

## Open Questions for Product
1. **Edit/delete windows** — exact windows for editing/deleting a review (BRULE-47); can removed reviews be appealed?
2. **Multi-dimensional ratings** — which dimensions per subject type at launch, or single-score MVP first?
3. **Doctor review sensitivity** — special handling for reviewing medical professionals (defamation/clinical-outcome concerns) — restrict to service aspects only?
4. **Moderation model** — pre-moderation (review before publish) vs post-moderation (publish then moderate on report)? Recommend post-moderation + auto-flag for speed.
5. **Anonymity** — are reviews shown with reviewer name, initials, or anonymous? (privacy vs accountability).
6. **Delivery driver reviews** — visible publicly or only feeding internal driver performance/earnings?

---

**End of Module 15 design.** Awaiting your approval to proceed. Recommended next module: **Admin & Platform Management** — the super-admin control plane: user/provider verification, platform configuration, content/catalog moderation, financial oversight, dispute resolution, and system-wide analytics (FR-ADM-01..12, BRULE-48..50), tying together the moderation/verification hooks referenced across modules.
