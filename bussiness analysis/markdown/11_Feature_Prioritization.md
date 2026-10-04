# PharmaLink Ethiopia — Feature Prioritization

**Document Type:** Feature Prioritization
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose
This document prioritizes platform features to guide sequencing and investment. It applies **MoSCoW** for release-scoping and **RICE** (Reach, Impact, Confidence, Effort) for comparative ranking, ensuring the core value loop is delivered first while managing risk and cost.

## 2. Prioritization Principles
- Deliver the **core medicine value loop** first: discover -> prescribe -> pay -> deliver.
- Prioritize **compliance and safety** features as non-negotiable enablers.
- Sequence **healthcare services** (appointments, diagnostics) after the marketplace foundation is proven.
- Defer enhancements that do not unblock the core loop or compliance.

## 3. MoSCoW Classification

### 3.1 Must Have (Release 1 — MVP)
- Account registration, login, OTP.
- Fayda ID identity verification (for Rx).
- Medicine search & catalog with real-time stock.
- Prescription upload & pharmacist verification.
- Intelligent pharmacy matching (stock, distance).
- Cart, checkout, order lifecycle.
- Secure payments (local) & refunds.
- Delivery dispatch & real-time tracking.
- Provider onboarding & license verification.
- Notifications (order lifecycle, verification).
- Admin console, audit logs, compliance basics.

### 3.2 Should Have (Release 2)
- Diaspora cross-border ordering & payment.
- Doctor appointment system & hospital directory.
- Diagnostic/lab test booking with preparation info.
- Ratings & reviews.
- Provider dashboards & analytics.
- Bulk inventory import; delivery proof-of-delivery.
- Multi-language (Amharic/English) completeness.

### 3.3 Could Have (Release 3+)
- Waiting lists for appointments.
- In-app messaging (customer–provider).
- Lab result delivery/notifications (with integration).
- Substitute recommendations & advanced search ranking.
- Cash-on-delivery (policy-dependent).
- Scheduled/future delivery.

### 3.4 Won't Have (Now)
- Telemedicine / video consultations.
- Insurance claim processing.
- Distributor ERP auto-integration.
- Wholesale/manufacturing.

## 4. RICE Scoring of Key Features
RICE = (Reach x Impact x Confidence) / Effort. Reach (users/quarter, relative 1–10), Impact (1–5), Confidence (0–1), Effort (person-months). Higher score = higher priority.

| Feature | Reach | Impact | Confidence | Effort | RICE | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Medicine search & stock | 10 | 5 | 0.9 | 4 | 11.3 | 1 |
| Prescription upload & verification | 9 | 5 | 0.9 | 4 | 10.1 | 2 |
| Pharmacy matching | 9 | 4 | 0.85 | 3 | 10.2 | 2 |
| Secure payments & refunds | 10 | 5 | 0.85 | 5 | 8.5 | 3 |
| Delivery dispatch & tracking | 9 | 5 | 0.8 | 5 | 7.2 | 4 |
| Provider onboarding & license verify | 8 | 5 | 0.9 | 4 | 9.0 | 3 |
| Admin & compliance tooling | 7 | 5 | 0.85 | 4 | 7.4 | 4 |
| Diaspora ordering | 6 | 4 | 0.7 | 4 | 4.2 | 5 |
| Doctor appointments | 7 | 4 | 0.75 | 5 | 4.2 | 5 |
| Hospital directory | 6 | 3 | 0.8 | 3 | 4.8 | 5 |
| Diagnostic/lab booking | 6 | 3 | 0.75 | 4 | 3.4 | 6 |
| Ratings & reviews | 7 | 3 | 0.8 | 2 | 8.4 | 3 |
| Lab result delivery | 5 | 3 | 0.5 | 4 | 1.9 | 7 |
| Telemedicine | 6 | 4 | 0.4 | 8 | 1.2 | 8 |

*Scores are planning estimates to be refined with data; they are directional, not absolute.*

## 5. Prioritization Summary (Value vs. Effort)
| Quadrant | Interpretation | Examples |
| --- | --- | --- |
| High Value / Low Effort | **Do first** | Medicine search, ratings, pharmacy matching |
| High Value / High Effort | **Plan & invest** | Payments, delivery, prescription verification, compliance |
| Low Value / Low Effort | **Quick wins later** | Notification preferences, saved addresses |
| Low Value / High Effort | **Defer/avoid now** | Telemedicine, insurance, result delivery |

## 6. Dependencies Affecting Sequencing
- Payments and identity verification must precede any purchase feature.
- License verification must precede any provider transacting.
- Prescription verification must precede Rx sales.
- Delivery depends on order and pharmacy readiness.
- Appointments/diagnostics depend on provider onboarding for those categories.

## 7. Recommendation
Deliver the **Must-have MVP** (Release 1) to prove the core medicine loop and compliance, then expand to **diaspora and healthcare services** (Release 2), followed by **enhancements** (Release 3+). See the Product Roadmap for the time-phased plan.
