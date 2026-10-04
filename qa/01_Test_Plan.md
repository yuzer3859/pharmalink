# PharmaLink Ethiopia — QA Test Plan

**Document type:** System and release QA test plan  
**Version:** 1.0  
**Status:** Baseline for execution  
**Scope:** `app` customer prototype and `web` pharmacy/admin portal services

## 1. Quality position

No feature is considered working based on implementation or visual presence. A workflow is **Passed** only when the expected behavior is observed in a running build, the result is repeatable, and evidence is recorded. Features that are only represented by static UI, mock data, simulated latency, or non-persistent local state are **Not verified** for production release.

The current repository contains two Vite applications. The customer app exposes home, medicines, doctors, diagnostics, tracking, checkout, and design-system routes. The portal contains typed service layers for inventory, orders, staff, and mock seed data. The business and non-functional requirements are marked draft, so release approval also requires product/compliance sign-off on final requirements.

## 2. Objectives

- Verify critical customer, pharmacy, delivery, payment, prescription, and compliance workflows.
- Detect regressions across functional, integration, API, security, performance, accessibility, and responsive behavior.
- Prove business rules such as prescription gating, valid-license matching, payment-before-order, order lifecycle, role scoping, and auditability.
- Establish objective release gates and a repeatable evidence trail.

## 3. In scope

### Functional

- Account registration, OTP, Fayda/KYC, password reset, profiles, beneficiaries, addresses, language, session timeout.
- Medicine search, generic/brand search, filters, sorting, stock, pharmacy eligibility, Rx controls, substitutes, cart, checkout, totals, and order history.
- Prescription upload/camera capture, secure storage, pharmacist queue, approve/reject reason, notification, expiry, quantity/refill limits, and reuse prevention.
- Pharmacy/provider onboarding, license verification, inventory, bulk import, order acceptance, re-match, dashboards, and suspension.
- Payment authorization, callbacks/webhooks, idempotency, refunds, settlement, reconciliation, ETB and cross-border handling, and card-data isolation.
- Delivery dispatch, accept/decline/reassignment, navigation, status updates, tracking, proof of delivery, cold-chain handling, and earnings.
- Doctor, hospital, diagnostic center, test/package search, booking, preparation instructions, reminders, cancellation, rescheduling, and no double-booking.
- Notifications, preferences, localization, ratings/reviews, disputes, admin controls, regulator read-only access, audit logs, reports, and records.

### Non-functional

- Search p95 <= 2 seconds; first meaningful content on 3G <= 4 seconds; payment round-trip <= 5 seconds excluding provider latency.
- Tracking refresh <= 10 seconds; launch capacity >= 10,000 concurrent users; 10x peak-volume behavior.
- Availability, failover, RTO <= 1 hour, RPO <= 15 minutes, backup/restore, and third-party outage behavior.
- TLS 1.2+, encryption at rest, RBAC/least privilege, MFA/OTP, OWASP Top 10, PCI scope, privacy, audit logging, and penetration testing.
- WCAG 2.1 AA, mobile-first responsive layout, English/Amharic localization, ETB formatting, and intermittent connectivity.

## 4. Out of scope until dependencies exist

The repository does not expose production backend endpoints or real integrations for Fayda ID, payment providers, maps, SMS/email/push, camera capture, storage, authentication, or databases. Those workflows require an integration environment, test credentials, contracts, and synthetic data before execution. Mock service behavior must not be used as production evidence.

## 5. Test levels and methods

| Level/method | Purpose | Minimum evidence |
| --- | --- | --- |
| Unit/component | Validate pure logic, field rules, status derivation, calculations, and UI states | Automated test report and coverage |
| Integration/API | Validate contracts, authorization, persistence, callbacks, retries, and idempotency | Request/response collection, schema assertions, logs |
| System/E2E | Validate end-to-end personas and cross-service workflows | Screenshots/video, IDs, timestamps, database/provider evidence |
| Regression | Re-run risk-based baseline after every change/release candidate | Versioned execution result |
| Performance/load | Validate latency, throughput, concurrency, degradation, and recovery | Load profile, p50/p95/p99, error rate, resource graphs |
| Security/penetration | Validate auth, access control, injection, abuse, secrets, uploads, privacy, and OWASP risks | Signed report, severity, retest evidence |
| UAT | Confirm business outcomes with customer, pharmacist, admin, rider, provider, and compliance personas | Signed scenarios and acceptance decision |

## 6. Test environments and data

- **Local UI:** current Node/npm toolchain, production-like build, browser DevTools, mobile emulation.
- **Integration:** isolated API environment with sandbox payment, identity, messaging, maps, object storage, and observability.
- **Staging:** production-like topology, TLS, RBAC, backups, rate limits, feature flags, and sanitized synthetic health/payment data.
- **Production validation:** smoke tests only, no real patient data, no destructive actions without approved change window.
- **Personas:** customer, verified customer, unverified customer, minor/guardian, diaspora customer, pharmacist, pharmacy operator, doctor, lab operator, rider, admin, superadmin, regulator.
- **Boundary data:** expired and invalid licenses; expired/illegible/forged Rx; zero/low/expired stock; duplicate callbacks; failed/slow payments; invalid files; concurrent slot/order requests; Unicode/Amharic; large values; revoked sessions.

## 7. Entry criteria

- Requirements, acceptance criteria, business rules, UX, API contracts, and compliance policy approved.
- Candidate build deployed and version identified.
- Test data, environments, credentials, integrations, logs, and rollback plan available.
- No open blocker preventing execution of critical-path tests.

## 8. Exit and release gates

Release is **blocked** if any condition applies:

- Any Severity 1/critical defect or unresolved safety, privacy, payment, authorization, or data-loss defect.
- Any Must requirement or critical acceptance criterion is not Passed or formally waived by product and compliance owners.
- Rx gating, license eligibility, payment authorization, order lifecycle, health-record access, audit logging, or refund behavior lacks evidence.
- Security assessment, penetration test, backup/restore, performance target, or accessibility baseline is incomplete.
- Regression pass rate is below 100% for P0/P1 cases, or failed tests have no approved risk acceptance.

Recommended release metrics: 100% P0/P1 pass, >= 95% overall planned pass, 0 open S1/S2, traceability for all Must requirements, and UAT sign-off from business/compliance owners.

## 9. Defect management

Each defect records build, environment, persona, preconditions, exact steps, expected/actual result, evidence, severity, priority, data IDs, logs, and regression impact.

- **S1 blocker:** safety, unauthorized access, payment/data loss, complete outage, or release-stopping defect.
- **S2 critical:** critical workflow unusable, incorrect dispensing/order/payment state, or major compliance breach.
- **S3 major:** important feature failure with workaround or significant data/display error.
- **S4 minor:** low-impact UI, copy, or cosmetic defect.

A fix is closed only after reproduction fails, the original case passes, impacted regression cases pass, and evidence is attached.

## 10. Traceability baseline

- `FR-AC`, `FR-MED`, `FR-RX`, `FR-MATCH`, `FR-ORD`, `FR-PAY`, `FR-DEL`, `FR-APPT`, `FR-HOSP`, `FR-LAB`, `FR-NOT`, `FR-PRV`, `FR-RAT`, `FR-ADM`, and `FR-REC` map to the functional suite in `02_Test_Cases.md`.
- `NFR-PERF`, `NFR-SEC`, `NFR-PRIV`, `NFR-USE`, `NFR-LOC`, `NFR-AVAIL`, `NFR-COMP`, and `NFR-AUDIT` map to non-functional cases and release gates.
- Acceptance criteria `AC-01` through `AC-48` are covered by the E2E/UAT scenarios; a mapping gap is itself a release defect.

## 11. Execution cadence

- PR: lint/typecheck/build plus targeted unit/component tests.
- Daily: smoke and changed-area regression.
- Release candidate: full functional regression, API contract, accessibility, security scan, performance, backup/restore, and UAT.
- Post-release: non-destructive smoke, monitoring verification, payment/order reconciliation, and incident review.

## 12. Required evidence

Store reports by build under `qa/evidence/<build-id>/`: test result export, browser/device matrix, API collection, performance summary, security report, accessibility report, defect list, screenshots/video, logs, and signed release decision.
