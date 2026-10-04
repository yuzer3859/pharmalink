# PharmaLink Ethiopia — Functional Requirements

**Document Type:** Functional Requirements Specification
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose
This document enumerates the detailed functional requirements (FR) of the platform, grouped by feature area. Each requirement is uniquely identified, testable, and traceable to business requirements (BR) and user stories (US). Priority uses MoSCoW (M=Must, S=Should, C=Could, W=Won't-now).

## 2. Account & Identity Management (FR-AC)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-AC-01 | The system shall allow users to register with phone number and/or email. | M |
| FR-AC-02 | The system shall verify user identity via Fayda ID for regulated actions. | M |
| FR-AC-03 | The system shall support OTP verification for registration and login. | M |
| FR-AC-04 | The system shall support role-based accounts (customer, pharmacy, doctor, rider, admin, etc.). | M |
| FR-AC-05 | The system shall allow users to create and edit a profile with contact and delivery details. | M |
| FR-AC-06 | The system shall allow secure password reset and account recovery. | M |
| FR-AC-07 | The system shall allow customers to add and manage beneficiaries (family members). | M |
| FR-AC-08 | The system shall support multiple saved delivery addresses with GPS coordinates. | S |
| FR-AC-09 | The system shall allow users to set preferred language (Amharic/English). | S |
| FR-AC-10 | The system shall enforce session timeout and secure re-authentication. | M |
| FR-AC-11 | The system shall allow users to view login history and active sessions. | C |
| FR-AC-12 | The system shall allow account deactivation and data-deletion requests per policy. | S |

## 3. Medicine Search & Catalog (FR-MED)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-MED-01 | The system shall allow searching medicines by brand and generic name. | M |
| FR-MED-02 | The system shall allow filtering by category, price range, and pharmacy distance. | M |
| FR-MED-03 | The system shall display product details: name, form, strength, price, and pharmacy. | M |
| FR-MED-04 | The system shall indicate whether a medicine requires a prescription (Rx/OTC). | M |
| FR-MED-05 | The system shall show real-time stock availability per pharmacy. | M |
| FR-MED-06 | The system shall suggest generic or in-stock substitutes when available. | S |
| FR-MED-07 | The system shall sort results by relevance, distance, price, or rating. | S |
| FR-MED-08 | The system shall display pharmacy rating and estimated delivery time on results. | S |
| FR-MED-09 | The system shall support browsing non-prescription health and wellness products. | S |
| FR-MED-10 | The system shall prevent adding Rx items to checkout without a valid prescription. | M |

## 4. Prescription Upload & Verification (FR-RX)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-RX-01 | The system shall allow uploading prescriptions as image or PDF. | M |
| FR-RX-02 | The system shall capture prescriptions via device camera. | M |
| FR-RX-03 | The system shall securely store prescriptions with encryption. | M |
| FR-RX-04 | The system shall route uploaded prescriptions to a licensed pharmacist for verification. | M |
| FR-RX-05 | The system shall allow pharmacists to approve or reject with a documented reason. | M |
| FR-RX-06 | The system shall notify the customer of verification outcome. | M |
| FR-RX-07 | The system shall link an approved prescription to eligible order items. | M |
| FR-RX-08 | The system shall retain prescription records for the regulatory retention period. | M |
| FR-RX-09 | The system shall prevent reuse of a single-use prescription beyond permitted dispensing. | M |

## 5. Intelligent Pharmacy Matching (FR-MATCH)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-MATCH-01 | The system shall match orders to licensed pharmacies that have the item in stock. | M |
| FR-MATCH-02 | The system shall rank candidate pharmacies by distance to the delivery address. | M |
| FR-MATCH-03 | The system shall factor price and pharmacy rating into ranking. | S |
| FR-MATCH-04 | The system shall allow customers to override and select a specific pharmacy. | S |
| FR-MATCH-05 | The system shall exclude pharmacies with expired or invalid licenses. | M |
| FR-MATCH-06 | The system shall re-match if the selected pharmacy declines or is unavailable. | M |
| FR-MATCH-07 | The system shall support splitting an order across pharmacies when necessary. | C |

## 6. Cart, Checkout & Orders (FR-ORD)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-ORD-01 | The system shall allow adding, updating, and removing cart items. | M |
| FR-ORD-02 | The system shall calculate order totals including item price, delivery, and fees. | M |
| FR-ORD-03 | The system shall allow selecting a delivery address and beneficiary. | M |
| FR-ORD-04 | The system shall place an order upon successful payment authorization. | M |
| FR-ORD-05 | The system shall maintain an order status lifecycle (placed, verified, accepted, dispatched, delivered, completed, cancelled). | M |
| FR-ORD-06 | The system shall allow customers to view order status and history. | M |
| FR-ORD-07 | The system shall allow order cancellation within permitted rules. | M |
| FR-ORD-08 | The system shall notify pharmacy and customer at each status change. | M |
| FR-ORD-09 | The system shall allow pharmacies to accept, prepare, and mark orders ready. | M |
| FR-ORD-10 | The system shall generate an itemized digital receipt/invoice. | S |
| FR-ORD-11 | The system shall support scheduled/future delivery time selection. | C |
| FR-ORD-12 | The system shall handle partial fulfillment and out-of-stock substitutions with customer consent. | S |

## 7. Payments & Settlements (FR-PAY)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-PAY-01 | The system shall process payments via integrated local providers (e.g., Telebirr, bank, card). | M |
| FR-PAY-02 | The system shall support cross-border payment for diaspora customers. | M |
| FR-PAY-03 | The system shall authorize payment before order confirmation. | M |
| FR-PAY-04 | The system shall record all transactions with unique references. | M |
| FR-PAY-05 | The system shall support full and partial refunds. | M |
| FR-PAY-06 | The system shall calculate and settle provider payouts net of platform fees. | M |
| FR-PAY-07 | The system shall provide payment/settlement reports to providers and admins. | M |
| FR-PAY-08 | The system shall support cash-on-delivery where enabled by policy. | C |
| FR-PAY-09 | The system shall detect and flag suspicious/fraudulent transactions. | S |
| FR-PAY-10 | The system shall reconcile payments with provider callbacks/webhooks. | M |
| FR-PAY-11 | The system shall never store raw card data (use tokenization/PCI-compliant provider). | M |

## 8. Delivery Management & Tracking (FR-DEL)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-DEL-01 | The system shall create a delivery job when an order is ready for dispatch. | M |
| FR-DEL-02 | The system shall dispatch jobs to available nearby delivery partners. | M |
| FR-DEL-03 | The system shall allow delivery partners to accept or decline jobs. | M |
| FR-DEL-04 | The system shall provide pickup and drop-off locations and navigation. | M |
| FR-DEL-05 | The system shall provide real-time tracking of delivery to the customer. | M |
| FR-DEL-06 | The system shall capture proof of delivery (confirmation/signature/photo). | S |
| FR-DEL-07 | The system shall support delivery status updates (picked up, en route, delivered). | M |
| FR-DEL-08 | The system shall reassign a job if a partner becomes unavailable. | M |
| FR-DEL-09 | The system shall calculate delivery fees by distance/zone. | S |
| FR-DEL-10 | The system shall record delivery partner earnings per completed job. | M |

## 9. Doctor Appointment System (FR-APPT)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-APPT-01 | The system shall provide a searchable directory of licensed doctors. | S |
| FR-APPT-02 | The system shall allow searching doctors by specialty, hospital, and location. | S |
| FR-APPT-03 | The system shall display doctor profiles (specialty, qualifications, fees, schedule, reviews). | S |
| FR-APPT-04 | The system shall display available appointment slots. | S |
| FR-APPT-05 | The system shall allow booking an appointment. | S |
| FR-APPT-06 | The system shall allow rescheduling and cancellation within rules. | S |
| FR-APPT-07 | The system shall send appointment reminders. | S |
| FR-APPT-08 | The system shall support joining a waiting list when fully booked. | C |
| FR-APPT-09 | The system shall allow viewing appointment history. | S |
| FR-APPT-10 | The system shall prevent double-booking of the same slot. | S |
| FR-APPT-11 | The system shall allow doctors/hospitals to manage availability calendars. | S |
| FR-APPT-12 | The system shall collect consultation fees where applicable. | C |

## 10. Hospital & Clinic Directory (FR-HOSP)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-HOSP-01 | The system shall maintain profiles for participating hospitals/clinics. | S |
| FR-HOSP-02 | The system shall display address, GPS, contact, and operating hours. | S |
| FR-HOSP-03 | The system shall display departments, specialties, and affiliated doctors. | S |
| FR-HOSP-04 | The system shall indicate emergency service availability. | S |
| FR-HOSP-05 | The system shall list hospitals nearest to the user first. | S |
| FR-HOSP-06 | The system shall allow search by city, specialty, or hospital name. | S |
| FR-HOSP-07 | The system shall display hospital ratings and reviews. | C |
| FR-HOSP-08 | The system shall allow navigating from a hospital to its doctors and vice versa. | S |

## 11. Diagnostic & Laboratory Booking (FR-LAB)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-LAB-01 | The system shall maintain profiles for verified diagnostic centers/labs. | S |
| FR-LAB-02 | The system shall list available tests, imaging, and screening packages. | S |
| FR-LAB-03 | The system shall display estimated pricing where available. | S |
| FR-LAB-04 | The system shall allow searching and comparing nearby diagnostic centers. | S |
| FR-LAB-05 | The system shall allow booking a diagnostic/lab appointment. | S |
| FR-LAB-06 | The system shall provide preparation instructions before tests. | S |
| FR-LAB-07 | The system shall send booking confirmations and reminders. | S |
| FR-LAB-08 | The system shall notify when results are ready (subject to provider integration). | C |
| FR-LAB-09 | The system shall allow rescheduling/cancellation within rules. | S |

## 12. Notifications & Communication (FR-NOT)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-NOT-01 | The system shall send notifications via push, SMS, and email. | M |
| FR-NOT-02 | The system shall notify order lifecycle events to relevant parties. | M |
| FR-NOT-03 | The system shall notify prescription verification outcomes. | M |
| FR-NOT-04 | The system shall send appointment and test reminders. | S |
| FR-NOT-05 | The system shall allow users to manage notification preferences. | S |
| FR-NOT-06 | The system shall support in-app messaging between customer and provider where permitted. | C |
| FR-NOT-07 | The system shall notify delivery partners of new job assignments. | M |
| FR-NOT-08 | The system shall localize notification content by user language. | S |

## 13. Provider Onboarding & Management (FR-PRV)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-PRV-01 | The system shall allow pharmacies, hospitals, doctors, labs, and riders to register. | M |
| FR-PRV-02 | The system shall require upload of valid licenses/credentials. | M |
| FR-PRV-03 | The system shall route provider applications to admin verification. | M |
| FR-PRV-04 | The system shall activate providers only after successful verification. | M |
| FR-PRV-05 | The system shall allow pharmacies to manage product catalog and stock. | M |
| FR-PRV-06 | The system shall allow bulk import/update of inventory. | S |
| FR-PRV-07 | The system shall allow providers to manage schedules/availability. | S |
| FR-PRV-08 | The system shall provide provider dashboards (orders, bookings, revenue). | M |
| FR-PRV-09 | The system shall flag and suspend providers with expired licenses. | M |
| FR-PRV-10 | The system shall allow providers to set operating hours and service zones. | S |
| FR-PRV-11 | The system shall allow providers to respond to reviews. | C |
| FR-PRV-12 | The system shall record provider compliance and performance metrics. | S |

## 14. Ratings, Reviews & Trust (FR-RAT)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-RAT-01 | The system shall allow customers to rate and review pharmacies, doctors, labs, and riders. | S |
| FR-RAT-02 | The system shall only permit reviews after a completed transaction. | S |
| FR-RAT-03 | The system shall display aggregate ratings on profiles. | S |
| FR-RAT-04 | The system shall allow admins to moderate/remove abusive reviews. | S |
| FR-RAT-05 | The system shall detect and prevent fraudulent/duplicate reviews. | C |
| FR-RAT-06 | The system shall factor ratings into search ranking. | C |

## 15. Administration, Analytics & Compliance (FR-ADM)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-ADM-01 | The system shall provide an admin console for platform operations. | M |
| FR-ADM-02 | The system shall provide verification queues for providers and prescriptions. | M |
| FR-ADM-03 | The system shall allow admins to suspend/reactivate users and providers. | M |
| FR-ADM-04 | The system shall provide dispute and refund management tools. | M |
| FR-ADM-05 | The system shall maintain immutable audit logs of sensitive actions. | M |
| FR-ADM-06 | The system shall provide dashboards for orders, GMV, users, and provider performance. | M |
| FR-ADM-07 | The system shall generate regulatory/compliance reports. | M |
| FR-ADM-08 | The system shall support configurable business rules (fees, zones, limits). | S |
| FR-ADM-09 | The system shall provide role and permission management. | M |
| FR-ADM-10 | The system shall monitor controlled-substance transactions and enforce limits. | M |
| FR-ADM-11 | The system shall support content/catalog moderation. | S |
| FR-ADM-12 | The system shall provide alerts for anomalies and fraud. | S |
| FR-ADM-13 | The system shall allow regulators read/audit access to relevant records. | S |
| FR-ADM-14 | The system shall export data for reporting and analysis. | S |

## 16. Health Records & History (FR-REC)
| ID | Requirement | Priority |
| --- | --- | --- |
| FR-REC-01 | The system shall securely store customer prescriptions. | S |
| FR-REC-02 | The system shall store order, appointment, and test history. | S |
| FR-REC-03 | The system shall allow customers to view and download their records. | S |
| FR-REC-04 | The system shall enforce access controls on health records. | M |
| FR-REC-05 | The system shall allow customers to manage records for beneficiaries. | S |
| FR-REC-06 | The system shall log all access to sensitive health records. | M |

## 17. Traceability (FR → BR)
| FR Group | Related BR |
| --- | --- |
| FR-AC | BR1, BR13, BR14 |
| FR-MED | BR2 |
| FR-RX | BR4, BR6 |
| FR-MATCH | BR5 |
| FR-ORD | BR3, BR12 |
| FR-PAY | BR11, BR12 |
| FR-DEL | BR10 |
| FR-APPT | BR7 |
| FR-HOSP | BR8 |
| FR-LAB | BR9 |
| FR-NOT | BR15 |
| FR-PRV | BR13 |
| FR-RAT | BR7, BR16 |
| FR-ADM | BR16, BR17 |
| FR-REC | BR14 |
