# Module 16 — Admin & Platform Management (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 16 — Admin & Platform Management (Verification, configuration, moderation, financial oversight, disputes, analytics)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** ALL modules (control plane). Core deps: Module 01 (Identity/RBAC/verification), 03 (Catalog moderation), 04/09 (provider oversight), 07 (finance), 15 (review moderation).
**Traceability:** FR-ADM-01..12, FR-PRV-03, FR-PAY-07, BRULE-48, BRULE-49, BRULE-50, NFR-SEC-06, NFR-AUDIT, NFR-COMP-01..05

> Single source of truth for the Admin & Platform Management bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This is the **platform control plane** — the super-admin surface that governs the whole marketplace: verifying providers, configuring platform-wide settings, moderating catalog/content, overseeing finances and settlements, resolving disputes, managing users, and viewing system-wide analytics.

**Design principle — orchestration, not ownership.** Admin operations act on data **owned by other modules** (users in 1, catalog in 3, pharmacies in 4, payments in 7, reviews in 15…). This module is a **thin orchestration + oversight layer** that calls each module's admin ports and existing capabilities — it does **not** duplicate their domains or bypass their invariants. Admin's *own* domain is narrow: **platform configuration, dispute cases, admin task/audit oversight, and cross-module analytics aggregation.**

**Every admin action is privileged and audited.** Given the power of these operations, this module leans hardest on Module 1's **RBAC (fine-grained admin permissions)** and the **hash-chained audit log** (BRULE-48, NFR-SEC-06, NFR-AUDIT) — every action is permission-gated and immutably recorded, with sensitive actions requiring elevated roles.

**Primary objectives**
- **Verification management** — review/approve/reject provider & professional applications (FR-ADM-01, FR-PRV-03, BRULE-05/07).
- **User & account management** — search, suspend, reinstate users; manage roles (FR-ADM-02/03, BRULE-49).
- **Content & catalog moderation** — product proposals, reviews, flagged content (FR-ADM-11).
- **Platform configuration** — fees, delivery pricing, feature flags, business rules parameters (FR-ADM-04, NFR-MAINT-03).
- **Financial oversight** — settlements, refunds approval, revenue/reconciliation reports (FR-ADM-05, FR-PAY-07).
- **Dispute resolution** — manage complaints/disputes across orders, deliveries, payments (FR-ADM-06, BRULE-50).
- **Analytics & reporting** — platform KPIs, operational and compliance dashboards (FR-ADM-07..10).
- **System oversight** — audit-log access, admin activity monitoring (FR-ADM-12, BRULE-48).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-AD-01 | Admins verify and approve/reject providers and professionals. | FR-ADM-01, FR-PRV-03, BRULE-05/07 |
| BR-AD-02 | Admins manage users (search, suspend, reinstate, roles). | FR-ADM-02/03, BRULE-49 |
| BR-AD-03 | Admins moderate catalog proposals, reviews, and flagged content. | FR-ADM-11 |
| BR-AD-04 | Admins configure platform parameters (fees, pricing, flags, rules). | FR-ADM-04, NFR-MAINT-03 |
| BR-AD-05 | Admins oversee settlements, approve refunds, view financial reports. | FR-ADM-05, FR-PAY-07 |
| BR-AD-06 | Admins manage disputes and complaints to resolution. | FR-ADM-06, BRULE-50 |
| BR-AD-07 | Admins access platform analytics and reports. | FR-ADM-07..10 |
| BR-AD-08 | All admin actions are permission-gated and audited. | FR-ADM-12, BRULE-48, NFR-SEC-06 |
| BR-AD-09 | Sensitive actions require elevated roles / separation of duties. | BRULE-48, NFR-SEC-06 |
| BR-AD-10 | Admin access to health/financial data is minimized and logged. | NFR-PRIV, BRULE-37 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Verification Management (FR-ADM-01)
- **F-AD-01** Verification queue across all applicant types (pharmacy, hospital, lab, doctor, driver).
- **F-AD-02** Review submitted documents (via Module 1 `verification_requests`); approve/reject with reason.
- **F-AD-03** Request additional documents; track SLA/aging.
- **F-AD-04** On approval → trigger the owning module's activation (Module 1/4/9/10 eligibility).

### 3.2 User & Account Management (FR-ADM-02/03)
- **F-AD-05** Search/filter users across roles; view profile + activity summary.
- **F-AD-06** Suspend / reinstate accounts with reason (BRULE-49); force logout (revoke sessions via Module 1).
- **F-AD-07** Assign/revoke roles & admin permissions (delegates to Module 1 RBAC).
- **F-AD-08** Impersonation for support — **strictly gated + audited** (optional; heightened controls).

### 3.3 Moderation (FR-ADM-11)
- **F-AD-09** Catalog product proposals queue → approve/reject/merge (delegates to Module 3).
- **F-AD-10** Review moderation queue → hide/remove/restore (delegates to Module 15).
- **F-AD-11** Flagged content/abuse reports across the platform in one view.

### 3.4 Platform Configuration (FR-ADM-04)
- **F-AD-12** Manage platform fees/commission, delivery pricing model, tax parameters.
- **F-AD-13** **Feature flags** (enable/disable modules/features, e.g., COD, split fulfillment, telemedicine).
- **F-AD-14** Business-rule parameters (reservation TTL, cancellation windows, concurrent-job limits, quiet hours).
- **F-AD-15** Manage taxonomies (catalog categories, provider facilities) via owning modules.
- **F-AD-16** Notification templates (delegates to Module 13).

### 3.5 Financial Oversight (FR-ADM-05, FR-PAY-07)
- **F-AD-17** Settlement runs review/approve/execute (delegates to Module 7).
- **F-AD-18** Refund approval queue for manual/high-value refunds.
- **F-AD-19** Revenue, GMV, reconciliation, and fraud-flag dashboards.

### 3.6 Dispute Resolution (FR-ADM-06)
- **F-AD-20** Dispute case management: create/track/resolve complaints tied to orders/deliveries/payments/appointments (BRULE-50).
- **F-AD-21** Resolution actions: refund, re-deliver, credit, penalize, escalate — executed via owning modules.
- **F-AD-22** Communication thread with involved parties; resolution SLA tracking.

### 3.7 Analytics & System Oversight (FR-ADM-07..12)
- **F-AD-23** KPI dashboards: users, orders/GMV, providers, appointments, delivery performance, revenue.
- **F-AD-24** Operational dashboards: order funnel, fulfillment times, cancellations, complaint rates.
- **F-AD-25** Compliance dashboards: license expiries, verification backlog, controlled-substance activity.
- **F-AD-26** **Audit-log explorer** — search the hash-chained audit trail (read-only) (FR-ADM-12, BRULE-48).
- **F-AD-27** Admin activity monitoring (who did what) + anomaly alerts.

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Security** | Least privilege, separation of duties (NFR-SEC-06, BRULE-48) | Fine-grained admin permissions (Module 1 RBAC); elevated roles for sensitive ops; optional maker-checker. |
| **Auditability** | Every action immutable-logged (BRULE-48, NFR-AUDIT) | All admin commands write hash-chained audit (actor, action, target, before/after). |
| **Privacy** | Minimize admin access to health/financial data (NFR-PRIV) | Purpose-bound access + heightened audit; masked views; break-glass for exceptional access. |
| **Reliability** | Config changes safe | Versioned config + validation + rollback; feature flags atomic. |
| **Performance** | Analytics without impacting OLTP (NFR-PERF) | Read from replicas / analytics store; async aggregation; cached dashboards. |
| **Correctness** | Admin never bypasses domain invariants | Acts via module ports/commands, not raw DB writes. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities (Admin-owned)
- **PlatformConfig** (aggregate root) — versioned key/value config + feature flags + business-rule parameters.
- **DisputeCase** (aggregate root) — a complaint/dispute with parties, thread, status, resolution (BRULE-50).
- **AdminTask** (entity) — a queued admin work item (verification, moderation, refund approval) — a unified worklist.
- **AdminActionRecord** (projection over audit) — admin activity view for oversight.
- (Verification requests, users, catalog proposals, reviews, settlements are **referenced**, owned elsewhere.)

### 5.2 Value Objects
- `ConfigKey`, `ConfigValue` (typed), `FeatureFlag`, `DisputeStatus` (OPEN|INVESTIGATING|RESOLVED|ESCALATED|CLOSED), `DisputeType` (ORDER|DELIVERY|PAYMENT|APPOINTMENT|CONTENT), `ResolutionAction`, `AdminPermission` (from Module 1), `TaskType`, `TaskStatus`.

### 5.3 Invariants
- Every admin command requires a **specific admin permission** (Module 1 RBAC) — no ambient admin power (BRULE-48).
- Admin actions **never mutate other modules' data directly** — they invoke those modules' commands/ports, preserving their invariants (e.g., a refund goes through Module 7's ledger, not a raw balance edit).
- **Sensitive actions** (financial approval, role elevation, impersonation, health-data access) require **elevated roles** and may require **maker-checker** (two-person) approval (NFR-SEC-06).
- Every admin action writes an **immutable audit entry** with actor, target, before/after (BRULE-48) — no exceptions.
- `PlatformConfig` changes are **versioned** with validation; invalid config is rejected, and rollback is possible.
- A `DisputeCase` resolution that moves money/stock executes via the owning module (traceable, reversible where needed).

**Design rationale — thin control plane over module ports.** Making Admin an orchestration layer (not a data owner) preserves each domain's integrity and audit trail: a suspension flows through Module 1, a refund through Module 7's ledger, a catalog merge through Module 3. Admin adds **oversight, workflow (queues/disputes), configuration, and analytics** — the things that are genuinely cross-cutting — without becoming a god-module that bypasses invariants.

---

## 6. Platform Configuration & Feature Flags (FR-ADM-04)

A central, **versioned config service** other modules read (cached) for tunable parameters — realizing the "config-driven" NFR (NFR-MAINT-03) referenced throughout (reservation TTL, cancellation windows, fees, quiet hours, concurrent limits…).

- **Typed config** with schema validation; namespaced by module (`payment.platformFeePercent`, `orders.reservationTtlMinutes`, `delivery.maxConcurrentJobs`).
- **Feature flags** toggle capabilities (COD, split fulfillment, telemedicine, new payment provider) — atomic, with targeting (e.g., % rollout, by region) later.
- **Change flow** — edit → validate → version → publish → modules pick up via `IConfigPort` (cached, short TTL) + config-changed event.
- **Audited + rollback** — every change recorded; revert to prior version.

**Design rationale.** Centralizing tunables removes hard-coded business parameters (the many "open questions" across modules become config, not redeploys) and gives one governed, audited place to change platform behavior safely.

---

## 7. Dispute Resolution (BRULE-50)

`DisputeCase` provides structured handling of complaints spanning modules:

- **Intake** — created by a user complaint or admin, linked to a `TransactionRef` (order/delivery/payment/appointment).
- **Investigation** — admin views the full cross-module context (order timeline, payment ledger, delivery PoD, prescription/consult where authorized) — access **purpose-bound + audited**.
- **Resolution actions** — refund (Module 7), re-delivery (Module 8), account penalty (Module 1), catalog/review action (3/15) — all executed through the owning module.
- **Thread + SLA** — communication with parties; aging/SLA tracking; escalation path.
- **Closure** — outcome recorded, parties notified, audit complete.

**Design rationale.** Disputes are inherently cross-module; a dedicated case aggregate gives one workflow + audit trail while resolution effects still route through authoritative modules (money via the ledger, etc.), keeping correctness and traceability.

---

## 8. Database Design (PostgreSQL via Prisma)

Admin owns a **small** schema; most data is referenced from other modules.

**platform_configs** — versioned config + flags.
- `id`, `namespace`, `key`, `value` (jsonb, typed), `value_type`, `version`, `is_active`, `updated_by` (FK), `created_at`. Unique (`namespace`,`key`,`version`).

**feature_flags**
- `id`, `key` (unique), `enabled` (bool), `targeting` (jsonb: %/region/role), `description`, `updated_by`, `updated_at`.

**dispute_cases** — aggregate root.
- `id`, `case_number` (unique), `type` (ORDER|DELIVERY|PAYMENT|APPOINTMENT|CONTENT), `transaction_type`, `transaction_id`, `complainant_user_id` (FK), `respondent_ref` (nullable), `status`, `priority`, `assigned_admin_id` (FK, nullable), `resolution` (jsonb: action + notes), `opened_at`, `resolved_at`, `sla_due_at`, `created_at`.

**dispute_messages** — case thread.
- `id`, `case_id` (FK), `sender_user_id` (FK), `sender_role`, `body`, `attachment_ref` (nullable), `created_at`.

**admin_tasks** — unified worklist (verification/moderation/refund approvals).
- `id`, `type` (VERIFICATION|CATALOG_PROPOSAL|REVIEW_REPORT|REFUND_APPROVAL|SETTLEMENT_APPROVAL|DISPUTE), `ref_type`, `ref_id`, `status` (PENDING|IN_PROGRESS|DONE), `assigned_to` (FK, nullable), `priority`, `sla_due_at`, `created_at`, `completed_at`. (A projection/index over source-module queues for one admin inbox.)

**maker_checker_approvals** — two-person control for sensitive actions.
- `id`, `action_type`, `payload` (jsonb), `requested_by` (FK), `approved_by` (FK, nullable), `status` (PENDING|APPROVED|REJECTED), `reason`, `created_at`, `decided_at`.

**analytics_snapshots** — precomputed dashboard aggregates.
- `id`, `metric_key`, `dimensions` (jsonb), `value` (jsonb), `period`, `computed_at`.

> **Audit** is **not** re-stored here — Admin reads the shared hash-chained `audit_logs` (Module 1) via a read-only explorer. This keeps one tamper-evident trail.

**Relationships**
- `dispute_cases 1—N dispute_messages`.
- `admin_tasks`, `maker_checker_approvals`, `analytics_snapshots` mostly reference other modules by id.

**Rationale.** The deliberately **thin schema** reflects the orchestration role: config, disputes, worklist, approvals, and cached analytics — everything else is referenced. `admin_tasks` unifies scattered queues (verification in 1, proposals in 3, reports in 15) into one inbox without owning them.

---

## 9. API Design

Base path: `/api/v1/admin`. All endpoints require specific admin permissions (Module 1 RBAC); sensitive ones require elevated roles / maker-checker. Envelope/errors per Module 1 §14. **Every call audited.**

### 9.1 Verification (`verification:manage`)
- **GET `/admin/verifications`** — unified queue (all applicant types), filter/aging.
- **GET `/admin/verifications/{id}`** — application + documents (Module 1).
- **POST `/admin/verifications/{id}/approve|reject`** — `{ reason, docs? }` → triggers owning-module activation.

### 9.2 Users (`user:manage:any`, `user:suspend:any`)
- **GET `/admin/users`** — search/filter. **GET `/admin/users/{id}`** — profile + activity.
- **POST `/admin/users/{id}/suspend|reinstate`** — `{ reason }` (BRULE-49) → Module 1 (revokes sessions).
- **POST `/admin/users/{id}/roles`** — assign/revoke (elevated). **POST `/admin/users/{id}/impersonate`** — gated + maker-checker + heavily audited.

### 9.3 Moderation
- **GET `/admin/moderation/catalog`** + **approve|reject|merge** → Module 3.
- **GET `/admin/moderation/reviews`** + **hide|remove|restore** → Module 15.
- **GET `/admin/moderation/flags`** — unified flagged-content view.

### 9.4 Configuration (`config:manage` — Super Admin)
- **GET `/admin/config`** / **PUT `/admin/config/{namespace}/{key}`** — versioned update (validated, audited, rollback).
- **GET/PUT `/admin/feature-flags`** — toggle features.
- **PUT `/admin/config/rules/*`** — business-rule params (TTLs, windows, limits).

### 9.5 Finance (`finance:manage:any`)
- **GET `/admin/finance/settlements`** + **approve|pay** → Module 7.
- **GET `/admin/finance/refunds/pending`** + **POST `/admin/finance/refunds/{id}/approve`** (maker-checker for high value).
- **GET `/admin/finance/reports`** — GMV/revenue/reconciliation/fraud (Module 7).

### 9.6 Disputes (`dispute:manage`)
- **CRUD `/admin/disputes`** — create/list/assign/update. **POST `/admin/disputes/{id}/message`** — thread.
- **POST `/admin/disputes/{id}/resolve`** — `{ action, params }` → executes via owning module; records outcome (BRULE-50).

### 9.7 Analytics & Audit (`analytics:read`, `audit:read`)
- **GET `/admin/analytics/*`** — KPI/operational/compliance dashboards (cached snapshots).
- **GET `/admin/audit`** — **read-only** hash-chained audit explorer (filter by actor/action/target/time) (FR-ADM-12, BRULE-48).
- **GET `/admin/admins/activity`** — admin action monitoring + anomalies.

**Representative errors:** `ADMIN_PERMISSION_DENIED`, `ELEVATED_ROLE_REQUIRED`, `MAKER_CHECKER_PENDING`, `CONFIG_VALIDATION_FAILED`, `DISPUTE_NOT_FOUND`, `RESOLUTION_ACTION_FAILED` (downstream module rejected), `VERIFICATION_ALREADY_DECIDED`, `VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/admin/
  domain/
    entities/            # PlatformConfig, FeatureFlag, DisputeCase, DisputeMessage, AdminTask,
    │                    # MakerCheckerApproval
    value-objects/       # ConfigKey, ConfigValue, DisputeStatus, DisputeType, ResolutionAction, TaskType
    events/              # ConfigChanged, FeatureFlagToggled, DisputeOpened, DisputeResolved,
    │                    # AdminActionExecuted, MakerCheckerRequested
    enums/               # DisputeStatus, DisputeType, TaskType, TaskStatus, ApprovalStatus
    repositories/        # IConfigRepository, IFeatureFlagRepository, IDisputeRepository,
    │                    # IAdminTaskRepository, IApprovalRepository, IAnalyticsRepository
    services/            # ConfigValidator, DisputeResolutionService, MakerCheckerPolicy, PermissionGate
  application/
    commands/            # ApproveVerification, SuspendUser, AssignRole, ModerateCatalog, ModerateReview,
    │                    # UpdateConfig, ToggleFeature, ApproveSettlement, ApproveRefund,
    │                    # OpenDispute, ResolveDispute, RequestApproval, DecideApproval
    queries/             # GetVerificationQueue, GetUsers, GetModerationQueues, GetConfig,
    │                    # GetFinanceReports, GetDisputes, GetAnalytics, GetAuditTrail, GetAdminActivity
    ports/               # IIdentityAdminPort(1), ICatalogAdminPort(3), IPharmacyAdminPort(4),
    │                    # IProviderAdminPort(9), IPaymentAdminPort(7), IReviewAdminPort(15),
    │                    # INotificationAdminPort(13), IAuditReadPort(1), IAnalyticsSourcePort(all),
    │                    # IConfigPublishPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/
    analytics/           # AnalyticsAggregator (reads replicas/warehouse), SnapshotScheduler
    ports-adapters/      # Identity/Catalog/Pharmacy/Provider/Payment/Review/Notification admin adapters
    config/              # ConfigCacheInvalidator (publishes ConfigChanged)
    audit/               # AuditReadAdapter (read-only over hash-chained logs)
  interface/
    http/
      controllers/       # VerificationAdminController, UserAdminController, ModerationController,
      │                  # ConfigController, FinanceAdminController, DisputeController,
      │                  # AnalyticsController, AuditExplorerController
      dtos/ guards/       # AdminPermissionsGuard, ElevatedRoleGuard, MakerCheckerGuard
      decorators/ filters/ interceptors/  # AdminAuditInterceptor (audits EVERY admin action)
  admin.module.ts
```

**Rationale.** Every admin capability maps to an `I*AdminPort` on the owning module — Admin **orchestrates**, never reaches into foreign tables. `AdminAuditInterceptor` guarantees BRULE-48 (all actions audited) uniformly. `MakerCheckerPolicy` + `ElevatedRoleGuard` implement separation of duties (NFR-SEC-06). `IAuditReadPort` gives a **read-only** window on the tamper-evident log (Admin can view but not alter history).

---

## 11. Sequence Flows

### 11.1 Provider Verification (FR-ADM-01)
```
Admin → GET /admin/verifications → unified queue (IIdentityAdminPort)
Admin → GET /admin/verifications/{id} → docs (audited access)
Admin → POST /admin/verifications/{id}/approve {reason}
ApproveVerification → AdminPermissionsGuard(verification:manage)
ApproveVerification → IIdentityAdminPort.approve → Module 1 sets org APPROVED
 → owning module activates (Pharmacy 4 / Provider 9 / Doctor 10 eligibility)
ApproveVerification → AdminAuditInterceptor: VERIFICATION_APPROVED (actor, target, reason)
 → notify applicant (Module 13)
```

### 11.2 Sensitive Action with Maker-Checker (NFR-SEC-06)
```
Admin A → POST /admin/finance/refunds/{id}/approve (high value)
ApproveRefund → MakerCheckerPolicy: threshold exceeded → RequestApproval (PENDING) → MAKER_CHECKER_PENDING
Admin B (elevated) → POST /admin/approvals/{id}/decide {approve}
DecideApproval → ElevatedRoleGuard; on APPROVE → IPaymentAdminPort.refund (Module 7 ledger)
 → both actions audited (requester + approver)
```

### 11.3 Config Change (FR-ADM-04)
```
SuperAdmin → PUT /admin/config/orders/reservationTtlMinutes {value: 20}
UpdateConfig → ConfigValidator: type/range valid?  else CONFIG_VALIDATION_FAILED
UpdateConfig → new version; is_active; emit ConfigChanged → IConfigPublishPort (cache invalidate)
 → Orders module reads new TTL via IConfigPort (short-TTL cache)
UpdateConfig → audit CONFIG_CHANGED (before/after, version)  [rollback available]
```

### 11.4 Dispute Resolution (BRULE-50)
```
User complaint → OpenDispute(type=DELIVERY, txnRef) → DisputeCase(OPEN) + AdminTask
Admin → investigate: cross-module context (order 6, delivery 8 PoD, payment 7) — purpose-bound audited reads
Admin → POST /admin/disputes/{id}/resolve {action: PARTIAL_REFUND, amount}
ResolveDispute → IPaymentAdminPort.refund (Module 7) [RESOLUTION_ACTION_FAILED if rejected]
ResolveDispute → status RESOLVED; notify parties; audit DISPUTE_RESOLVED
```

### 11.5 Audit Explorer (BRULE-48, read-only)
```
Admin → GET /admin/audit?actor=&action=&from=&to=
GetAuditTrail → AdminPermissionsGuard(audit:read)
GetAuditTrail → IAuditReadPort: query hash-chained audit_logs (READ ONLY; chain integrity verifiable)
→ 200 [immutable entries]  (this read is itself audited)
```

---

## 12. Error Handling

Reuses Module 1 §14. Authorization is strict and layered: `ADMIN_PERMISSION_DENIED` (missing permission), `ELEVATED_ROLE_REQUIRED` (sensitive op), `MAKER_CHECKER_PENDING` (awaiting second approver). `CONFIG_VALIDATION_FAILED` prevents bad config from publishing. `RESOLUTION_ACTION_FAILED` surfaces when a downstream module rejects an admin-initiated effect (admin can't force past a domain invariant). Downstream failures never leave a dispute/action half-applied — effects route through the owning module's transactional path.

---

## 13. Logging & Auditing

This module is the **primary consumer and guardian** of the audit system. **Every** admin action is written to the hash-chained `audit_logs` via `AdminAuditInterceptor` — actor, permission used, target module/entity, before/after snapshot, reason, and (for maker-checker) both parties (BRULE-48, NFR-SEC-06). Access to sensitive data (health/financial) during investigations is **purpose-bound and logged**. The audit explorer itself is read-only and its reads are audited. Admin activity monitoring flags anomalies (e.g., unusual suspension volume, off-hours access). This closes the platform-wide accountability loop referenced by every prior module.

---

## 14. Future Scalability & Evolution

- **Analytics warehouse** — move dashboards to a dedicated OLAP store / warehouse (replicas → ETL) so heavy analytics never touch OLTP (NFR-PERF); `analytics_snapshots` is the interim.
- **Granular RBAC & SoD** — expand admin permission taxonomy + maker-checker coverage as the team grows; regional/scoped admins.
- **Advanced feature flags** — %-rollout, A/B, regional targeting behind the existing flag model.
- **Automated compliance** — auto-alerts for license expiries, controlled-substance anomalies, fraud patterns (feeds from 4/7/9).
- **AI ops (future)** — anomaly detection on admin activity + dispute triage assistance, behind ports; humans decide.
- **Extraction-ready** — Admin is already a thin orchestration layer over module admin-ports + a read-only audit view; it can become a separate control-plane service, and the analytics piece a separate reporting service.

---

## Open Questions for Product/Compliance
1. **Admin role taxonomy** — what distinct admin roles (super admin, finance admin, verification officer, moderator, support) and their exact permission sets (BRULE-48)?
2. **Maker-checker scope** — which actions require two-person approval (refund thresholds, role elevation, config classes)?
3. **Impersonation** — is support impersonation allowed at all, and under what consent/audit constraints (privacy-sensitive)?
4. **Analytics stack** — build dashboards in-app vs integrate a BI tool (Metabase/Superset) reading replicas?
5. **Dispute SLAs & policies** — resolution SLAs, escalation ladder, and standard remedies per dispute type (BRULE-50).
6. **Data-access minimization** — rules/limits for admin access to health records and financial detail during investigations (NFR-PRIV, BRULE-37).

---

**End of Module 16 design.** This completes the **16-module architecture** for PharmaLink Ethiopia across Phase 1 (pharmacy marketplace), Phase 2 (healthcare services), and the cross-cutting platform modules.

**Suggested consolidation next steps** (optional, your call):
1. An **architecture index / README** linking all 16 module docs with the phase roadmap and a cross-module dependency diagram.
2. A **shared-conventions doc** (audit, error envelope, RBAC, outbox/events, config port) extracted from the patterns repeated across modules.
3. A **domain event catalog** (all events emitted/consumed) to lock down inter-module contracts before implementation.

Want me to proceed with the architecture index + dependency map, or adjust any module first?
