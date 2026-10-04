# PharmaLink Ethiopia — Stakeholder Analysis

**Document Type:** Stakeholder Analysis
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose

This document identifies every party that affects, or is affected by, the PharmaLink Ethiopia platform. It classifies stakeholders by influence and interest, records their goals and pain points, and defines an engagement strategy for each. It is the foundation for the Business Requirements Specification (BRS) and all downstream documentation.

## 2. Scope

The analysis covers the full product vision: medicine search and delivery, prescription handling, pharmacy operations, doctor appointments, hospital directory, diagnostic and laboratory booking, delivery logistics, payments, and regulatory compliance across Ethiopia, including diaspora ordering.

## 3. Stakeholder Categories

Stakeholders are grouped as **Primary** (directly use or operate the platform), **Secondary** (support or are indirectly involved), and **Key Influencers** (control approvals, funding, or regulation).

## 4. Stakeholder Register

| ID | Stakeholder | Category | Role / Interest | Influence | Interest |
| --- | --- | --- | --- | --- | --- |
| S01 | Patients / Customers (local) | Primary | Find, buy, and receive medicines; book appointments and tests | Medium | High |
| S02 | Diaspora Customers | Primary | Order medicines and services for family in Ethiopia from abroad | Medium | High |
| S03 | Licensed Pharmacies | Primary | Sell medicines, manage inventory and orders, grow reach | High | High |
| S04 | Pharmacists | Primary | Verify prescriptions, ensure safe dispensing | High | High |
| S05 | Hospitals & Clinics | Primary | List services, manage doctor availability and bookings | High | Medium |
| S06 | Doctors / Medical Specialists | Primary | Manage profiles, schedules, and appointments | Medium | High |
| S07 | Diagnostic Centers & Laboratories | Primary | List tests, manage bookings and results | Medium | Medium |
| S08 | Delivery Partners / Riders | Primary | Accept and fulfill delivery jobs, earn income | Medium | High |
| S09 | Platform Administrators | Primary | Operate, monitor, and moderate the ecosystem | High | High |
| S10 | Regulatory Authorities (EFDA/FMHACA, MoH) | Key Influencer | Enforce licensing, drug safety, data protection | High | Medium |
| S11 | Payment Providers (Telebirr, banks, gateways) | Secondary | Process payments and settlements | High | Medium |
| S12 | Fayda ID (National ID) Authority | Secondary | Provide digital identity verification | High | Low |
| S13 | Pharmaceutical Suppliers / Distributors | Secondary | Supply stock to pharmacies (future integration) | Medium | Medium |
| S14 | Health Insurance Providers | Secondary | Cover eligible costs (future feature) | Medium | Low |
| S15 | Investors / Funders | Key Influencer | Provide capital, expect return and growth | High | High |
| S16 | Product & Engineering Team | Secondary | Build and maintain the platform | Medium | High |
| S17 | Customer Support Team | Secondary | Resolve issues, maintain satisfaction | Low | High |
| S18 | General Public / Community | Secondary | Beneficiaries of improved healthcare access | Low | Medium |

## 5. Influence / Interest Matrix

Stakeholders are managed according to their position on the power–interest grid.

| Quadrant | Strategy | Stakeholders |
| --- | --- | --- |
| High Influence / High Interest | **Manage Closely** — engage continuously, co-design, prioritize | Licensed Pharmacies, Pharmacists, Platform Administrators, Investors, Hospitals |
| High Influence / Low–Medium Interest | **Keep Satisfied** — consult, ensure compliance, no surprises | Regulators, Payment Providers, Fayda ID Authority |
| Low–Medium Influence / High Interest | **Keep Informed** — regular updates, gather feedback | Patients, Diaspora Customers, Doctors, Delivery Partners, Support Team, Engineering |
| Low Influence / Low Interest | **Monitor** — minimal effort, periodic review | General Public, Insurance Providers (until activated), Suppliers (until integrated) |

## 6. Detailed Stakeholder Profiles

### 6.1 Patients / Customers (Local) — S01
- **Goals:** Quickly find in-stock medicines nearby, upload prescriptions, pay securely, and track delivery; book doctor and lab appointments.
- **Pain Points:** Visiting multiple pharmacies, stock uncertainty, manual appointment booking, travel cost and time.
- **Success Measures:** Time-to-medicine, order success rate, appointment convenience.
- **Engagement:** In-app feedback, ratings, support channels, onboarding guidance.

### 6.2 Diaspora Customers — S02
- **Goals:** Purchase medicines and healthcare services for family in Ethiopia from abroad, with trust and transparency.
- **Pain Points:** No secure remote channel, currency and payment barriers, lack of visibility into fulfillment.
- **Success Measures:** Successful cross-border orders, delivery confirmation, trust.
- **Engagement:** International payment support, notifications, proof of delivery.

### 6.3 Licensed Pharmacies — S03
- **Goals:** Reach more customers, digitize inventory and orders, increase sales, remain compliant.
- **Pain Points:** Reliance on walk-ins, limited digital presence, manual stock and order handling.
- **Success Measures:** Order volume, new customers, fulfillment speed, revenue growth.
- **Engagement:** Merchant onboarding, training, dashboards, revenue reporting.

### 6.4 Pharmacists — S04
- **Goals:** Safely verify prescriptions and dispense correct medicines.
- **Pain Points:** Illegible or fraudulent prescriptions, liability concerns.
- **Success Measures:** Verification accuracy, dispensing safety, low error rate.
- **Engagement:** Verification tools, audit trails, clear workflows.

### 6.5 Hospitals & Clinics — S05
- **Goals:** Improve service visibility, manage doctor schedules and appointment demand.
- **Pain Points:** Manual scheduling, no-shows, limited discoverability.
- **Success Measures:** Appointment utilization, reduced no-shows, patient reach.
- **Engagement:** Institution onboarding, schedule management tools, analytics.

### 6.6 Doctors / Medical Specialists — S06
- **Goals:** Maintain accurate profiles, control availability, receive qualified bookings.
- **Pain Points:** Overbooking, no-shows, administrative overhead.
- **Success Measures:** Utilization, patient satisfaction, schedule accuracy.
- **Engagement:** Profile control, calendar tools, reminders, reviews.

### 6.7 Diagnostic Centers & Laboratories — S07
- **Goals:** List tests and imaging, manage bookings, deliver results.
- **Pain Points:** Low discoverability, manual scheduling, result delivery friction.
- **Success Measures:** Booking volume, preparation compliance, result turnaround.
- **Engagement:** Service catalog tools, booking management, result notifications.

### 6.8 Delivery Partners / Riders — S08
- **Goals:** Receive fair, optimized delivery jobs and reliable payouts.
- **Pain Points:** Idle time, unclear routing, delayed payment.
- **Success Measures:** Jobs completed, earnings, on-time delivery rate.
- **Engagement:** Rider app, job dispatch, navigation, transparent payouts.

### 6.9 Platform Administrators — S09
- **Goals:** Operate a safe, compliant, high-quality marketplace; onboard and moderate providers.
- **Pain Points:** Fraud, quality control, dispute handling, compliance monitoring.
- **Success Measures:** Platform health, compliance rate, dispute resolution time.
- **Engagement:** Admin console, verification workflows, analytics, audit logs.

### 6.10 Regulatory Authorities — S10
- **Goals:** Ensure only licensed entities operate; enforce drug safety and data protection.
- **Pain Points:** Limited visibility into digital pharmaceutical commerce.
- **Success Measures:** Compliance, traceability, auditability.
- **Engagement:** License validation, reporting, audit access, controlled-substance controls.

### 6.11 Payment Providers — S11
- **Goals:** Process transactions securely and settle funds accurately.
- **Success Measures:** Transaction success rate, settlement accuracy, fraud prevention.
- **Engagement:** Integration, reconciliation, dispute/chargeback handling.

### 6.12 Fayda ID Authority — S12
- **Goals:** Provide trusted national identity verification.
- **Engagement:** Secure API integration, privacy-preserving verification.

### 6.13 Investors / Funders — S15
- **Goals:** Sustainable growth, market leadership, return on investment.
- **Pain Points:** Regulatory risk, adoption risk, unit economics.
- **Success Measures:** GMV, active users, retention, margin, compliance posture.
- **Engagement:** Roadmap visibility, KPI reporting, milestone reviews.

## 7. Stakeholder Needs vs. Platform Response (Summary)

| Stakeholder | Primary Need | Platform Response |
| --- | --- | --- |
| Patients | Find medicines fast, safely | Search, prescription matching, verified pharmacies, tracking |
| Diaspora | Order remotely with trust | Cross-border ordering, secure payment, proof of delivery |
| Pharmacies | More customers, digital ops | Marketplace listing, inventory & order management |
| Doctors/Hospitals | Efficient scheduling | Appointment system, calendars, reminders |
| Diagnostics/Labs | Bookings & result delivery | Test catalog, booking, result notifications |
| Delivery Partners | Fair, steady jobs | Dispatch, routing, transparent payouts |
| Regulators | Compliance & safety | License validation, audit trails, controlled-drug rules |
| Investors | Growth & returns | Scalable ecosystem, analytics, defensible market position |

## 8. Assumptions and Open Questions

- **A1:** Regulatory approval will permit online sale and delivery of prescription medicines under defined controls.
- **A2:** Fayda ID integration will be available for identity verification.
- **A3:** At least one major digital payment provider (e.g., Telebirr) will be integrable at launch.
- **Q1:** Will controlled/narcotic medicines be excluded from online sale in Phase 1? *(Requires regulator confirmation.)*
- **Q2:** Are hospitals and labs willing to expose real-time availability, or only request-based booking initially?
- **Q3:** Will lab results be delivered in-platform, or only notified with pickup at the provider?

*Open questions are tracked and must be resolved with the relevant stakeholders before the corresponding requirements are finalized.*
