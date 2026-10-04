# PharmaLink Ethiopia — Software Requirements Specification (SRS)

**Document Type:** Software Requirements Specification (IEEE 830-aligned)
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Introduction

### 1.1 Purpose
This SRS specifies the functional and non-functional requirements for the PharmaLink Ethiopia platform. It is intended for product managers, architects, developers, QA engineers, and stakeholders responsible for validation. It translates the business requirements (BRS) into system-level specifications.

### 1.2 Product Scope
PharmaLink Ethiopia is a multi-sided digital healthcare marketplace connecting patients (local and diaspora), licensed pharmacies, hospitals, doctors, diagnostic centers/laboratories, delivery partners, administrators, and regulators. It supports medicine commerce, prescription handling, appointment and test booking, delivery logistics, payments, notifications, and compliance.

### 1.3 Definitions, Acronyms, Abbreviations
| Term | Definition |
| --- | --- |
| Rx | Prescription-only medicine |
| OTC | Over-the-counter medicine |
| GMV | Gross Merchandise Value |
| Fayda ID | Ethiopian national digital identity |
| EFDA | Ethiopian Food and Drug Authority |
| KYC | Know Your Customer identity verification |
| SLA | Service Level Agreement |
| PII | Personally Identifiable Information |

### 1.4 References
Project Vision, Problem Statement, BRS, Stakeholder Analysis, and downstream Functional/Non-functional Requirements, Business Rules, and Acceptance Criteria documents.

## 2. Overall Description

### 2.1 Product Perspective
The platform is a cloud-based, service-oriented system with web and mobile clients for distinct user roles, integrating with external services: Fayda ID (identity), payment providers (e.g., Telebirr, banks, cards), mapping/geolocation, SMS/email/push notification providers, and (future) insurance and distributor systems.

### 2.2 User Classes and Characteristics
| User Class | Description | Technical Skill |
| --- | --- | --- |
| Customer (local) | Buys medicines, books services | Low–Medium |
| Diaspora Customer | Orders remotely for beneficiaries | Medium |
| Pharmacy Operator | Manages catalog, stock, orders | Medium |
| Pharmacist | Verifies prescriptions | Medium |
| Hospital/Clinic Admin | Manages doctors, schedules | Medium |
| Doctor | Manages availability, appointments | Low–Medium |
| Diagnostic/Lab Operator | Manages tests, bookings, results | Medium |
| Delivery Partner | Fulfills deliveries | Low |
| Platform Administrator | Operates & moderates platform | High |
| Regulator (read/audit) | Reviews compliance data | Medium |

### 2.3 Operating Environment
- **Clients:** Responsive web (modern browsers) and Android/iOS mobile apps.
- **Backend:** Cloud-hosted, horizontally scalable services with relational and object storage.
- **Connectivity:** Must degrade gracefully on low-bandwidth mobile networks.

### 2.4 Design and Implementation Constraints
- Compliance with Ethiopian pharmaceutical, healthcare, and data-protection laws.
- Multi-language support (e.g., Amharic and English) and localization.
- Controlled-substance handling per regulation.
- Availability of Fayda ID and payment provider APIs.

### 2.5 Assumptions and Dependencies
- External identity, payment, mapping, and notification services are available and reliable.
- Providers digitize their catalogs, inventory, and availability.

## 3. System Features (Functional Overview)

Each feature lists a description and references to detailed functional requirements (**FR**, see Functional Requirements document). Priority uses MoSCoW.

### 3.1 Account & Identity Management — Must
Registration, login, role-based profiles, Fayda ID verification, password/OTP security, and account recovery. *Refs: FR-AC-01..FR-AC-12.*

### 3.2 Medicine Search & Catalog — Must
Search and filter medicines by name, generic, category, price, and pharmacy proximity; product detail pages; substitute suggestions. *Refs: FR-MED-01..FR-MED-10.*

### 3.3 Prescription Upload & Verification — Must
Secure upload (image/PDF), pharmacist verification workflow, approval/rejection with reasons, secure storage. *Refs: FR-RX-01..FR-RX-09.*

### 3.4 Intelligent Pharmacy Matching — Must
Match orders to licensed pharmacies by stock availability, distance, price, and rating; ranked recommendations. *Refs: FR-MATCH-01..FR-MATCH-07.*

### 3.5 Cart, Checkout & Orders — Must
Cart management, order placement, order status lifecycle, order history, cancellations. *Refs: FR-ORD-01..FR-ORD-12.*

### 3.6 Payments & Settlements — Must
Local and cross-border payments, refunds, provider settlement, transaction records. *Refs: FR-PAY-01..FR-PAY-11.*

### 3.7 Delivery Management & Tracking — Must
Delivery job dispatch, rider acceptance, route/navigation support, real-time tracking, proof of delivery. *Refs: FR-DEL-01..FR-DEL-10.*

### 3.8 Doctor Appointment System — Should
Doctor directory, availability, booking/rescheduling/cancellation, reminders, waiting list, appointment history. *Refs: FR-APPT-01..FR-APPT-12.*

### 3.9 Hospital & Clinic Directory — Should
Institution profiles, departments, doctors, emergency info, proximity-based listing and search. *Refs: FR-HOSP-01..FR-HOSP-08.*

### 3.10 Diagnostic & Laboratory Booking — Should
Test/imaging catalog, booking, preparation instructions, result-ready notifications. *Refs: FR-LAB-01..FR-LAB-09.*

### 3.11 Notifications & Communication — Must
Multi-channel notifications (push/SMS/email) for order and appointment events; in-app messaging where permitted. *Refs: FR-NOT-01..FR-NOT-08.*

### 3.12 Provider Onboarding & Management — Must
Provider registration, license upload and verification, catalog/schedule management, dashboards. *Refs: FR-PRV-01..FR-PRV-12.*

### 3.13 Ratings, Reviews & Trust — Should
Ratings and reviews for pharmacies, doctors, labs, and delivery partners; moderation. *Refs: FR-RAT-01..FR-RAT-06.*

### 3.14 Administration, Analytics & Compliance — Must
Admin console, verification queues, dispute resolution, audit logs, analytics dashboards, regulatory reporting. *Refs: FR-ADM-01..FR-ADM-14.*

### 3.15 Health Records & History — Should
Secure storage of prescriptions, orders, appointments, and results; user access controls. *Refs: FR-REC-01..FR-REC-06.*

## 4. External Interface Requirements

### 4.1 User Interfaces
- Responsive, accessible, multilingual UI (Amharic/English) across web and mobile.
- Role-specific dashboards for customers, providers, riders, and administrators.

### 4.2 Hardware Interfaces
- Mobile device GPS for location and delivery tracking.
- Device camera for prescription capture.

### 4.3 Software Interfaces
| Interface | Purpose |
| --- | --- |
| Fayda ID API | Identity verification (KYC) |
| Payment Gateway/Telebirr/Bank APIs | Payments, refunds, settlement |
| Mapping/Geolocation API | Distance, routing, tracking |
| Notification Providers (SMS/Email/Push) | Alerts and reminders |
| Insurance APIs (future) | Coverage verification |
| Distributor/Supplier APIs (future) | Stock replenishment |

### 4.4 Communication Interfaces
- HTTPS/TLS for all client-server communication.
- Webhooks/callbacks for payment and delivery status updates.

## 5. Non-Functional Requirements (Summary)
Performance, scalability, availability, security, privacy, usability, accessibility, localization, reliability, maintainability, and compliance. *Detailed in the Non-functional Requirements document.*

## 6. System Data (Conceptual)

### 6.1 Core Entities
User, Customer, Beneficiary, Pharmacy, Pharmacist, Product/Medicine, Inventory, Prescription, Order, OrderItem, Payment, DeliveryJob, DeliveryPartner, Hospital, Doctor, Appointment, DiagnosticCenter, Test, TestBooking, Review, Notification, License, AuditLog.

### 6.2 Key Relationships (Narrative)
A Customer places Orders containing OrderItems fulfilled by a Pharmacy from its Inventory; Rx OrderItems reference a verified Prescription. Payments settle Orders and provider payouts. DeliveryJobs link Orders to DeliveryPartners. Appointments link Customers to Doctors (affiliated with Hospitals). TestBookings link Customers to Tests at DiagnosticCenters. Licenses gate Pharmacy, Doctor, Hospital, and DiagnosticCenter activation. AuditLogs record sensitive actions.

## 7. Traceability Matrix (BR → Feature → FR)
| Business Req | System Feature | FR Group |
| --- | --- | --- |
| BR1, BR13, BR14 | Account & Identity; Provider Onboarding | FR-AC, FR-PRV |
| BR2 | Medicine Search & Catalog | FR-MED |
| BR3, BR11 | Orders; Payments | FR-ORD, FR-PAY |
| BR4, BR6 | Prescription Upload & Verification | FR-RX |
| BR5 | Intelligent Pharmacy Matching | FR-MATCH |
| BR7 | Doctor Appointment System | FR-APPT |
| BR8 | Hospital & Clinic Directory | FR-HOSP |
| BR9 | Diagnostic & Laboratory Booking | FR-LAB |
| BR10 | Delivery Management & Tracking | FR-DEL |
| BR12 | Orders; Payments; Admin | FR-ORD, FR-PAY, FR-ADM |
| BR15 | Notifications | FR-NOT |
| BR16 | Administration, Analytics & Compliance | FR-ADM |
| BR17 | Business Rules enforcement | FR-ORD, FR-RX, FR-ADM |

## 8. Open Issues
- Confirm Rx scope and controlled-substance handling for Phase 1.
- Confirm payment provider(s) and cross-border capability.
- Confirm result-delivery model for diagnostics.
- Confirm initial launch geography.
