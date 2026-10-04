# PharmaLink Ethiopia — Test Case Catalog

**Status legend:** `Not Run`, `Passed`, `Failed`, `Blocked`, `Not Applicable`  
**Priority:** `P0` release blocker, `P1` critical, `P2` important, `P3` lower risk

Execution requires recording status, build, environment, tester, date, evidence, defect ID, and notes for every case. The initial status of all cases is `Not Run`; implementation is not evidence.

## A. Customer identity and access

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-AC-001 | P0 | FR-AC-01/03; AC-01 | New phone/email | Register with valid and invalid identifiers; request OTP; submit valid, invalid, expired, reused, and rate-limited OTPs | Valid OTP creates one account; invalid states are rejected clearly; OTP is single-use and rate limited |
| QA-AC-002 | P0 | FR-AC-02; AC-02; BRULE-01 | Customer with Rx item | Attempt Rx checkout unverified; complete Fayda verification; retry | Unverified user is blocked with guidance; verified user is allowed; verification state is audited |
| QA-AC-003 | P1 | FR-AC-06; AC-03 | Existing account and active sessions | Request reset; use valid/invalid/expired OTP; set weak/strong password; reuse old session | Only compliant password succeeds; old sessions are invalidated; no account enumeration |
| QA-AC-004 | P1 | FR-AC-04/10; BRULE-02 | Multiple roles and sessions | Access customer, pharmacy, admin, superadmin routes with each role; expire session; replay token | Least privilege is enforced server-side; timeout requires re-authentication; no cross-role data exposure |
| QA-AC-005 | P1 | FR-AC-05/07/08; AC-04/05 | Verified customer | Add/edit/delete beneficiary and multiple addresses, including invalid GPS and minor guardian data; select at checkout | Valid records persist and are selectable; invalid/inunauthorized records fail; beneficiary/address access is isolated |
| QA-AC-006 | P2 | FR-AC-09; AC-06 | User account | Switch English/Amharic; reload; inspect UI, validation, notifications, dates, and RTL/Unicode rendering | Selection persists and all supported strings/localized formats render without truncation or fallback leakage |

## B. Medicine discovery and cart

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-MED-001 | P0 | FR-MED-01; AC-07 | Catalog with brand/generic names | Search exact, partial, case variants, Unicode, empty, special characters, and no-match values | Correct matches are returned; no-match state is safe; p95 search meets 2 seconds |
| QA-MED-002 | P0 | FR-MED-02/05; AC-08/09; BRULE-05/15/18 | Pharmacies with varied stock, distance, license, expiry | Apply category, price, distance, in-stock, nearby; compare sorting | Only valid-stock licensed pharmacies appear; filters and proximity/price/rating sorting are accurate |
| QA-MED-003 | P0 | FR-MED-03/04/10; AC-10 | OTC and Rx items | Inspect detail/list badges; add Rx item without prescription; add with expired/rejected/approved Rx | Strength/form/price/pharmacy and Rx state are clear; unauthorized Rx checkout is impossible |
| QA-MED-004 | P1 | FR-MED-06; AC-11; BRULE-16 | Out-of-stock item and substitute | Open item, view substitute, choose substitute, decline substitution | Only eligible generic/in-stock substitutes appear; consent and pharmacist approval are recorded when required |
| QA-ORD-001 | P0 | FR-ORD-01/02; AC-12 | Catalog items | Add duplicate items; change quantities to zero, negative, max, and above stock; remove; reload | Cart totals and quantities are correct; invalid quantities are rejected; stock cannot be oversold |
| QA-ORD-002 | P0 | FR-MATCH-01/05/06/07; BRULE-18/19 | Multiple candidate pharmacies | Place item with stock; make top pharmacy decline or lose stock; test split fulfillment | Matching excludes invalid pharmacies, ranks by rule, re-matches, and handles split/consent without losing order integrity |

## C. Prescription and safety

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-RX-001 | P0 | FR-RX-01/02/03; AC-13 | Rx checkout | Upload valid JPG/PNG/PDF; camera capture; upload oversized, corrupt, executable, password-protected, and malicious polyglot files | Allowed files are securely stored and linked; unsafe/invalid files are rejected; content type is validated server-side |
| QA-RX-002 | P0 | FR-RX-04/05; AC-14/15; BRULE-11/14 | Pending Rx and pharmacist role | Open queue as pharmacist/non-pharmacist; approve; reject without/with reason; inspect audit log | Only licensed pharmacist can review; rejection reason required; eligible approval links items; all actions audited |
| QA-RX-003 | P0 | FR-RX-06/08/09; AC-16; BRULE-12/13 | Approved/rejected, expired, single-use Rx | Dispense full quantity; exceed quantity/refills; reuse; expire Rx; attempt controlled substance | Customer receives correct outcome; limits, validity, retention, and controlled-substance policy are enforced |
| QA-RX-004 | P0 | NFR-SEC-10; NFR-PRIV; BRULE-04/39 | Two customers/providers and health records | Attempt IDOR access, download, search, share, and admin/regulator read-only access | Only authorized transactional parties access records; every access is logged; regulator cannot mutate |

## D. Pharmacy/provider operations

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-PRV-001 | P0 | FR-PRV-01..04; AC-17/44; BRULE-05..09 | Provider applicant | Submit valid, expired, forged, duplicate license and missing documents; admin approve/reject | Application enters queue; only approved and valid providers transact; decisions/reasons are audited |
| QA-PRV-002 | P0 | FR-PRV-05/09; AC-18; BRULE-08/15 | Approved pharmacy | Create/update stock, expiry, price, SKU; expire license/stock; inspect customer view | Customer availability is synchronized; expired stock/provider is hidden and suspended automatically |
| QA-PRV-003 | P1 | FR-PRV-06; AC-21 | Pharmacy and mixed-quality CSV | Import valid, duplicate, missing, malformed, huge, and unauthorized rows | Atomicity/partial policy is explicit; validation summary identifies each success/error; no cross-pharmacy writes |
| QA-PRV-004 | P0 | FR-PRV-08; AC-20; NFR-SEC-03 | Pharmacy/admin scopes | View dashboards and query other pharmacy IDs as pharmacy, admin, superadmin | Pharmacy sees only its data; admin scope is correct; superadmin access is intentional and audited |
| QA-PRV-005 | P0 | FR-ORD-09; AC-19 | Matched order | Accept, prepare, mark ready, decline, duplicate transition, out-of-stock | Valid state transitions notify parties; invalid/replayed transitions are rejected; decline triggers re-match |

## E. Checkout, payment, settlement

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-PAY-001 | P0 | FR-ORD-03/04; FR-PAY-03; BRULE-17 | Cart, address, beneficiary | Check out with valid/invalid address and beneficiary; authorize success, decline, timeout, cancel | Correct totals are shown; order exists only after authorization except enabled COD; no duplicate order |
| QA-PAY-002 | P0 | FR-PAY-01/04/10/11; AC-22 | Payment sandbox | Send success, failure, duplicate, out-of-order, forged, delayed callback/webhook; inspect storage/logs | Webhooks are authenticated, idempotent, reconciled, and uniquely referenced; raw card data is never stored/logged |
| QA-PAY-003 | P0 | FR-PAY-05; AC-23; BRULE-24 | Eligible and ineligible orders | Refund full/partial for cancellation, failed delivery, dispute, duplicate request, and ineligible state | Policy is enforced; original method/reference recorded; totals and order state remain consistent |
| QA-PAY-004 | P1 | FR-PAY-06/07; AC-24/25; BRULE-22/23/25 | Completed orders and FX rate | Run settlement with fees, tax/rounding, ETB and cross-border currency, retry run | Net payout and statement reconcile exactly; immutable transaction references and repeat-safe settlement |

## F. Delivery and tracking

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-DEL-001 | P0 | FR-DEL-01/02/03; AC-26; BRULE-27/28 | Pharmacy-ready order and riders | Mark ready; dispatch to nearby available/unavailable riders; accept/decline simultaneously | Job is created only when ready, assigned by rule, limited by capacity, and re-offered safely |
| QA-DEL-002 | P1 | FR-DEL-04/07/08; AC-27 | Accepted job | Open pickup/drop-off, navigation, pickup, en-route, partner loss, reassignment | Locations/navigation available; valid state sequence enforced; reassignment preserves tracking and audit history |
| QA-DEL-003 | P0 | FR-DEL-05/06; AC-28/29; BRULE-29/30 | Out-for-delivery order | Observe updates over time; use stale/offline GPS; complete without/with proof; temperature-sensitive item | Refresh is <=10 seconds under target; stale state is clear; mandatory proof and cold-chain rules block invalid completion |
| QA-DEL-004 | P1 | FR-DEL-10; AC-30 | Completed delivery | Inspect rider earnings, duplicate completion, cancellation | Correct fee is recorded once and visible only to authorized rider/admin |

## G. Appointments, hospitals, diagnostics

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-CARE-001 | P1 | FR-APPT-01..04; AC-31/32 | Verified providers and slots | Search by specialty/hospital/location; inspect profiles, fees, reviews, schedules | Only verified providers appear; details and nearest-first order are accurate |
| QA-CARE-002 | P1 | FR-APPT-05/06/10; AC-33; BRULE-31/32 | One available slot, two customers | Book concurrently; reschedule/cancel before and after cutoff | Exactly one booking succeeds; cutoff rules are enforced; history and notifications update |
| QA-CARE-003 | P2 | FR-APPT-07/09/11; AC-34/35 | Appointment and doctor role | Update availability; schedule reminder; view history | Invalid slots cannot book; reminder arrives in configured window; history is complete |
| QA-CARE-004 | P1 | FR-HOSP-01..08; AC-36 | Hospital records | Search by name/city/specialty; inspect GPS/hours/emergency; navigate hospital-doctor links | Verified records are accurate, linked, and usable on mobile |
| QA-CARE-005 | P1 | FR-LAB-01..07; AC-37/38/40 | Verified lab/test catalog | Search/filter tests; book center/home package; inspect price/prep and confirmation | Only verified centers list; preparation appears before confirmation; booking and availability persist |
| QA-CARE-006 | P2 | FR-LAB-08/09; AC-39 | Completed diagnostic booking | Trigger result-ready event; reschedule/cancel before/after cutoff; attempt unauthorized result access | Correct notification/access policy applies; cutoff and record controls are enforced |

## H. Notifications, trust, admin, records

| ID | Pri | Traceability | Preconditions | Steps | Expected result |
| --- | --- | --- | --- | --- | --- |
| QA-COM-001 | P1 | FR-NOT-01..08 | Events and user preferences | Trigger order/Rx/appointment/delivery events; toggle channels/language; simulate provider outage | Correct party receives one localized notification; preferences and retry/fallback behavior work |
| QA-COM-002 | P2 | FR-RAT-01..06; AC-47 | Completed and incomplete transactions | Review completed, pending, duplicate, abusive, and fraudulent interactions | Only eligible reviews accepted; duplicates/moderation/ranking behavior and audit trail are correct |
| QA-ADM-001 | P0 | FR-ADM-01..05/09/10; AC-44..48; BRULE-39/40 | Admin, superadmin, regulator roles | Verify/suspend provider; process dispute/refund; manage role; access audit/report/export; regulator attempts write | Least privilege, immutable audit events, controlled-substance rules, read-only regulator access, and exports work |
| QA-ADM-002 | P1 | FR-ADM-06..08/11..14; NFR-AUDIT | Seeded operational data | Compare dashboard KPIs to source transactions; export; change fee/zone/limit; moderate catalog | Metrics reconcile; config changes are authorized/versioned; exports contain no unauthorized PII |
| QA-REC-001 | P0 | FR-REC-01..06; AC-47/48; NFR-PRIV | Customer, beneficiary, provider, regulator records | View/download/correct/delete request; test retention and access logs | Access is scoped and logged; policy-based retention/deletion is enforced without breaking regulatory holds |

## I. Regression, compatibility, accessibility, resilience

| ID | Pri | Traceability | Steps | Expected result |
| --- | --- | --- | --- | --- |
| QA-REG-001 | P0 | Global DoD | Run all P0 cases on release candidate and after every critical fix | 100% pass; no new critical regressions |
| QA-REG-002 | P1 | NFR-USE-03/05 | Keyboard-only navigation, screen reader labels, focus order, contrast, zoom 200%, reduced motion, mobile widths | WCAG 2.1 AA baseline passes; no blocked core task |
| QA-REG-003 | P1 | NFR-LOC-01..04 | Test ETB/FX/Amharic, slow 3G, offline/online transitions, duplicate submissions | Formats and language are correct; safe retry/degradation; no data corruption |
| QA-REG-004 | P1 | NFR-AVAIL-01..05 | Kill service, database, queue, payment, map, SMS; restore backup; observe failover | Graceful error, retry/idempotency, alerting, RTO/RPO and no lost/duplicated orders |
| QA-REG-005 | P1 | NFR-PORT-02 | Test supported current/two prior Android/iOS and Chrome/Firefox/Safari/Edge viewports | Core flows are usable and consistent within support matrix |

## J. API, security, performance, penetration, UAT

| ID | Pri | Traceability | Method | Expected result |
| --- | --- | --- | --- | --- |
| QA-API-001 | P0 | NFR-INTEROP | Contract-test auth, inventory, orders, staff, prescription, payment, delivery, booking endpoints with valid/invalid schema | Versioned HTTPS contracts, validation, error model, pagination, and authorization are correct |
| QA-API-002 | P0 | NFR-SEC-03/10 | Test IDOR/BOLA, broken function authorization, tenant scope, token replay, CSRF/CORS, rate limits | Unauthorized read/write always denied and logged; no cross-tenant data leakage |
| QA-SEC-001 | P0 | NFR-SEC-01..09; NFR-PRIV | SAST, dependency scan, DAST, secret scan, SQL/NoSQL/command/XSS injection, SSRF, upload abuse, session/MFA testing | No unresolved high/critical findings; sensitive data and secrets are protected |
| QA-PEN-001 | P0 | NFR-SEC-05/08; R04/R10/R21 | Independent authorized penetration test against staging, including payment/Rx/records/admin paths | Report delivered, critical/high findings remediated or formally accepted, retest passed |
| QA-PERF-001 | P1 | NFR-PERF-01..05; NFR-SCAL | Baseline, load, stress, spike, soak, and failover tests at launch and 10x peak profiles | Targets met or capacity risks documented; no unsafe order/payment duplication |
| QA-UAT-001 | P0 | AC-01..48; NFR-COMP | Customer, pharmacist, pharmacy, rider, doctor/lab, admin, diaspora, regulator scenario walkthroughs | Business owners sign all applicable scenarios; exceptions have approved disposition |
