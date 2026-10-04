# PharmaLink Ethiopia — Business Rules

**Document Type:** Business Rules Catalog
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose
Business rules define the constraints, policies, and conditions that govern platform behavior independent of implementation. They are enforced by functional requirements and validated through acceptance criteria. Rules are grouped by domain and uniquely identified (BRULE).

## 2. Identity & Access Rules
| ID | Rule |
| --- | --- |
| BRULE-01 | A user must verify identity (Fayda ID) before performing regulated actions such as purchasing prescription medicines. |
| BRULE-02 | A user account must have exactly one primary role but may hold linked provider roles subject to verification. |
| BRULE-03 | A minor's account (below legal age) must be managed by a verified adult guardian. |
| BRULE-04 | Access to health records and prescriptions is restricted to the owner, authorized beneficiaries, and verified providers with a valid transactional relationship. |

## 3. Provider Eligibility Rules
| ID | Rule |
| --- | --- |
| BRULE-05 | Only pharmacies with a valid, unexpired license may list and sell medicines. |
| BRULE-06 | Only licensed doctors may be listed for appointments; credentials must be verified. |
| BRULE-07 | Only verified hospitals, clinics, and diagnostic centers may publish services. |
| BRULE-08 | A provider whose license expires is automatically suspended from transacting until renewed. |
| BRULE-09 | Delivery partners must complete identity verification and onboarding before accepting jobs. |

## 4. Medicine & Prescription Rules
| ID | Rule |
| --- | --- |
| BRULE-10 | Prescription-only (Rx) medicines cannot be dispensed without a pharmacist-verified prescription. |
| BRULE-11 | A prescription must be verified as valid, legible, and within its validity period before fulfillment. |
| BRULE-12 | A single-use prescription may not be dispensed beyond the prescribed quantity or permitted refills. |
| BRULE-13 | Controlled or narcotic substances follow strict regulatory handling or are excluded from online sale. |
| BRULE-14 | A pharmacist must record a documented reason when rejecting a prescription. |
| BRULE-15 | Only medicines with valid, non-expired stock may be offered for sale. |
| BRULE-16 | Substitution of a prescribed medicine requires customer consent and, where applicable, pharmacist approval. |

## 5. Ordering & Matching Rules
| ID | Rule |
| --- | --- |
| BRULE-17 | An order can only be confirmed after successful payment authorization (except where cash-on-delivery is enabled). |
| BRULE-18 | Orders are matched only to licensed pharmacies that have the required items in stock. |
| BRULE-19 | If a matched pharmacy declines or cannot fulfill, the order is re-matched to the next best pharmacy. |
| BRULE-20 | A customer may cancel an order only before it is dispatched, subject to the cancellation policy. |
| BRULE-21 | Diaspora orders must specify a valid beneficiary and delivery address within Ethiopia. |

## 6. Payment & Settlement Rules
| ID | Rule |
| --- | --- |
| BRULE-22 | All monetary amounts are recorded in ETB; cross-border payments are converted at the applicable rate. |
| BRULE-23 | Platform fees are deducted before provider settlement. |
| BRULE-24 | Refunds are issued only for eligible cancellations, failed deliveries, or verified disputes. |
| BRULE-25 | A completed transaction must have a unique, immutable transaction reference. |
| BRULE-26 | Raw card data must never be stored by the platform. |

## 7. Delivery Rules
| ID | Rule |
| --- | --- |
| BRULE-27 | A delivery job is created only after the pharmacy marks the order ready. |
| BRULE-28 | A delivery partner may hold a limited number of concurrent active jobs (configurable). |
| BRULE-29 | Proof of delivery is required to mark an order delivered where policy mandates. |
| BRULE-30 | Temperature-sensitive medicines must be flagged and handled per storage requirements. |

## 8. Appointment & Diagnostic Rules
| ID | Rule |
| --- | --- |
| BRULE-31 | An appointment slot cannot be booked by more than one patient (no double-booking). |
| BRULE-32 | Cancellation or rescheduling must occur before the provider's cutoff window. |
| BRULE-33 | A no-show may be recorded and may affect future booking privileges (configurable). |
| BRULE-34 | Diagnostic bookings must display required preparation instructions before confirmation. |
| BRULE-35 | Lab results are released only to the patient/authorized beneficiary per provider policy. |

## 9. Ratings, Trust & Moderation Rules
| ID | Rule |
| --- | --- |
| BRULE-36 | A customer may review a provider only after a completed transaction with that provider. |
| BRULE-37 | Abusive, fraudulent, or duplicate reviews may be removed by administrators. |
| BRULE-38 | Providers with sustained poor ratings or compliance breaches may be suspended for review. |

## 10. Compliance & Audit Rules
| ID | Rule |
| --- | --- |
| BRULE-39 | All sensitive actions (verification, dispensing, refunds, suspensions) must be logged in an immutable audit trail. |
| BRULE-40 | Regulators may be granted read/audit access to compliance-relevant records. |
| BRULE-41 | Health and prescription records must be retained for the regulatory retention period and then handled per policy. |
| BRULE-42 | Any suspected counterfeit or unsafe medicine report triggers immediate provider review and potential suspension. |

## 11. Rule-to-Requirement Traceability (Sample)
| Business Rule | Enforced By (FR) |
| --- | --- |
| BRULE-01 | FR-AC-02, FR-MED-10 |
| BRULE-05, BRULE-08 | FR-PRV-02, FR-PRV-04, FR-PRV-09, FR-MATCH-05 |
| BRULE-10, BRULE-11 | FR-RX-04..FR-RX-07, FR-MED-10 |
| BRULE-17 | FR-ORD-04, FR-PAY-03 |
| BRULE-19 | FR-MATCH-06 |
| BRULE-31 | FR-APPT-10 |
| BRULE-39 | FR-ADM-05, FR-REC-06 |
