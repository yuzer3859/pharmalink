# PharmaLink Ethiopia — Business Requirements Specification (BRS)

**Document Type:** Business Requirements Specification
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Introduction

### 1.1 Purpose
This BRS defines the business need, objectives, scope, and high-level requirements for PharmaLink Ethiopia. It communicates *what the business must achieve* and *why*, providing the bridge between the project vision and the detailed software requirements (SRS). It is written for business sponsors, investors, regulators, and delivery teams.

### 1.2 Business Background
Access to medicines and healthcare services in Ethiopia is fragmented. Patients visit multiple pharmacies to locate medicines, appointment booking is manual, and there is no unified digital channel connecting pharmacies, hospitals, doctors, diagnostic centers, delivery partners, and patients — including diaspora customers ordering on behalf of family.

### 1.3 Business Opportunity
A secure, centralized digital healthcare marketplace can reduce the time and cost of accessing medicines and services, expand reach for licensed providers, create income for delivery partners, and give regulators transparency — while establishing a defensible, scalable national healthcare platform.

## 2. Business Objectives

| ID | Objective | Success Metric (Target) |
| --- | --- | --- |
| BO1 | Reduce time to locate and obtain medicines | Median time-to-fulfillment < 3 hours in covered areas |
| BO2 | Increase digital reach for licensed pharmacies | 500+ verified pharmacies onboarded within 18 months |
| BO3 | Enable secure diaspora ordering | 10% of orders originating from abroad within 24 months |
| BO4 | Digitize doctor and diagnostic appointments | 100+ providers with online scheduling within 18 months |
| BO5 | Ensure regulatory compliance and patient safety | 100% of active sellers license-verified; zero major safety incidents |
| BO6 | Build a sustainable marketplace | Positive contribution margin per order by month 18 |
| BO7 | Deliver a trusted, high-quality experience | CSAT >= 4.3/5; order success rate >= 95% |

## 3. Business Scope

### 3.1 In Scope
- Medicine search, purchase, and delivery from licensed pharmacies.
- Secure prescription upload and pharmacist verification.
- Intelligent pharmacy matching by location, stock, and price.
- Doctor appointment booking with hospitals and individual specialists.
- Hospital and clinic directory.
- Diagnostic center and laboratory test booking.
- Delivery partner logistics and real-time tracking.
- Secure online payments (local and cross-border) and settlements.
- Identity verification (Fayda ID) and provider license verification.
- Notifications, order history, and secure health records storage.
- Administration, analytics, and compliance tooling.

### 3.2 Out of Scope (Current Phase)
- Telemedicine / live video consultations.
- Health insurance claim processing (planned future feature).
- Automated integration with pharmaceutical distributors' ERP systems (future).
- In-house drug manufacturing or wholesale distribution.
- Clinical diagnosis or medical advice by the platform itself.

### 3.3 Assumptions
- Regulatory frameworks permit controlled online pharmaceutical commerce with defined safeguards.
- Fayda ID and at least one major payment provider are integrable.
- Providers are willing to digitize inventory and availability.

### 3.4 Constraints
- Must comply with Ethiopian pharmaceutical, healthcare, and data-protection regulations.
- Must operate under variable connectivity and device capability across regions.
- Controlled substances subject to strict or excluded handling.

## 4. Stakeholders (Summary)
Patients, diaspora customers, licensed pharmacies, pharmacists, hospitals, doctors, diagnostic centers, delivery partners, administrators, regulators, payment providers, and investors. See the *Stakeholder Analysis* document for full detail.

## 5. High-Level Business Requirements

Requirements are prefixed **BR** and traced downstream to functional requirements (FR) and user stories (US).

### 5.1 Customer & Access
- **BR1:** The platform shall allow customers to register, verify identity, and manage a secure profile.
- **BR2:** The platform shall allow customers to search medicines and healthcare services by name, category, location, and availability.
- **BR3:** The platform shall allow diaspora customers to order for beneficiaries within Ethiopia.

### 5.2 Medicines & Prescriptions
- **BR4:** The platform shall allow secure upload of prescriptions.
- **BR5:** The platform shall match prescriptions and orders to suitable licensed pharmacies with available stock.
- **BR6:** The platform shall require pharmacist verification before dispensing prescription-only medicines.

### 5.3 Healthcare Services
- **BR7:** The platform shall enable booking, rescheduling, and cancellation of doctor appointments.
- **BR8:** The platform shall provide a hospital/clinic directory with services and availability.
- **BR9:** The platform shall enable booking of diagnostic and laboratory services.

### 5.4 Fulfillment & Payments
- **BR10:** The platform shall coordinate delivery via delivery partners with real-time tracking.
- **BR11:** The platform shall process secure online payments and provider settlements.
- **BR12:** The platform shall support refunds, cancellations, and dispute handling.

### 5.5 Trust, Compliance & Operations
- **BR13:** The platform shall verify licenses of pharmacies, doctors, hospitals, and diagnostic centers before activation.
- **BR14:** The platform shall protect personal and medical data per applicable regulations.
- **BR15:** The platform shall provide notifications across all order and appointment stages.
- **BR16:** The platform shall provide administrative, analytics, audit, and compliance tools.
- **BR17:** The platform shall enforce controlled-substance rules or exclusions per regulation.

## 6. Business Process Overview (Narrative)
A customer searches for a medicine or service. For medicines, they may upload a prescription; the platform matches to a licensed pharmacy with stock, a pharmacist verifies, the customer pays, a delivery partner is assigned, and the order is tracked to delivery. For services, the customer selects a provider and available slot, books and pays (where applicable), receives reminders, and attends. Administrators verify providers, monitor quality and compliance, and resolve disputes. *Detailed flows are in the Process Flow Diagrams document.*

## 7. Benefits Realization

| Beneficiary | Expected Benefit |
| --- | --- |
| Patients | Faster, safer, more convenient access to medicines and services |
| Diaspora | Reliable remote care support for family |
| Pharmacies | Expanded reach and digital operations |
| Doctors/Hospitals | Efficient scheduling and higher utilization |
| Diagnostics/Labs | More bookings and streamlined result delivery |
| Delivery Partners | Fair, steady income opportunities |
| Regulators | Transparency, traceability, and compliance |
| Investors | Scalable, defensible national healthcare platform |

## 8. Success Criteria
The project is successful when the business objectives (Section 2) are met, active providers are fully license-verified, customer satisfaction and order success targets are achieved, and the platform operates within regulatory compliance without major safety incidents.

## 9. High-Level Risks (Summary)
Regulatory approval for online prescription sales, provider adoption, payment and identity integration dependencies, delivery reliability, data protection, and counterfeit-medicine prevention. *Full detail in the Risk Analysis document.*

## 10. Traceability
Each **BR** maps forward to functional requirements (**FR**), user stories (**US**), and acceptance criteria (**AC**). A consolidated traceability matrix is maintained in the SRS and Acceptance Criteria documents.

## 11. Open Questions
- **OQ1:** Will Phase 1 include prescription (Rx) medicines or start with OTC only pending regulatory sign-off?
- **OQ2:** Which payment provider(s) are confirmed for launch, and do they support cross-border flows?
- **OQ3:** What is the geographic launch area (e.g., Addis Ababa first)?
- **OQ4:** Are lab results delivered in-platform or via provider only?

*These must be resolved with sponsors and regulators before finalizing scope.*
