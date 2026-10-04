# PharmaLink Ethiopia — Acceptance Criteria

**Document Type:** Acceptance Criteria (Gherkin-style)
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose
This document defines testable acceptance criteria (AC) for each user story, using the **Given / When / Then** format. Each AC is traceable to its user story (US) and the functional requirements (FR) it validates. A story is "Done" only when all its acceptance criteria pass.

## 2. Account & Identity

### AC-01 (US-01) Register with phone number
- **Given** a new user on the registration screen
- **When** they enter a valid phone number and request an OTP
- **Then** the system sends an OTP and creates the account upon correct verification.
- **And** an invalid or expired OTP is rejected with a clear message.

### AC-02 (US-02) Fayda ID identity verification
- **Given** a registered customer who wants to buy Rx medicines
- **When** they complete Fayda ID verification
- **Then** their account is marked verified and Rx purchases are enabled.
- **And** unverified customers are blocked from Rx checkout with guidance to verify.

### AC-03 (US-03) Secure password reset
- **Given** a user who selects "forgot password"
- **When** they verify via OTP and set a new compliant password
- **Then** the password is updated and old sessions are invalidated.

### AC-04 (US-04) Manage beneficiaries
- **Given** a verified customer
- **When** they add a beneficiary with name and address
- **Then** the beneficiary is available for selection at checkout.

### AC-05 (US-05) Multiple delivery addresses
- **Given** a customer at checkout
- **When** they save and select among multiple addresses
- **Then** the chosen address (with GPS) is applied to the order.

### AC-06 (US-06) Language selection
- **Given** any user
- **When** they select Amharic or English
- **Then** the interface and notifications render in the chosen language.

## 3. Medicine Discovery & Purchase

### AC-07 (US-07) Search by name
- **Given** a customer on the search screen
- **When** they enter a brand or generic name
- **Then** matching medicines are returned within 2 seconds (95th percentile).

### AC-08 (US-08) Nearby in-stock pharmacies
- **Given** a searched medicine
- **When** results are displayed
- **Then** only pharmacies with available stock are shown, sorted by proximity.
- **And** pharmacies with expired licenses are excluded.

### AC-09 (US-09) Filter by price and distance
- **Given** search results
- **When** the customer applies price and distance filters
- **Then** results update to match the selected criteria.

### AC-10 (US-10) Rx indicator
- **Given** a medicine that requires a prescription
- **When** it is displayed
- **Then** it is clearly marked as Rx and cannot be checked out without a valid prescription.

### AC-11 (US-11) Substitute suggestions
- **Given** an out-of-stock item
- **When** the customer views it
- **Then** available generic/in-stock substitutes are suggested where they exist.

### AC-12 (US-12) Cart and checkout
- **Given** items in the cart
- **When** the customer checks out
- **Then** totals (items, delivery, fees) are shown and an order is created only after payment authorization.

## 4. Prescription Handling

### AC-13 (US-13) Upload prescription
- **Given** a customer with an Rx item
- **When** they upload an image/PDF or capture via camera
- **Then** the file is stored securely and linked to the order for verification.

### AC-14 (US-14) Pharmacist review
- **Given** an uploaded prescription
- **When** a licensed pharmacist opens the verification queue
- **Then** they can view the prescription and associated order items.

### AC-15 (US-15) Approve/reject with reason
- **Given** a pharmacist reviewing a prescription
- **When** they reject it
- **Then** a documented reason is required and recorded in the audit log.
- **And** approval links the prescription to eligible order items.

### AC-16 (US-16) Verification notification
- **Given** a completed verification
- **When** the outcome is set
- **Then** the customer is notified of approval or rejection with next steps.

## 5. Pharmacy Operations

### AC-17 (US-17) Pharmacy onboarding
- **Given** a pharmacy applicant
- **When** they submit registration and a valid license
- **Then** the application enters the admin verification queue and the pharmacy cannot transact until approved.

### AC-18 (US-18) Catalog and stock management
- **Given** an approved pharmacy
- **When** they add/update products and stock levels
- **Then** customer-facing availability reflects the changes.

### AC-19 (US-19) Receive and accept orders
- **Given** a new matched order
- **When** the pharmacy accepts it
- **Then** the order moves to "preparing" and both parties are notified.
- **And** if declined, the system re-matches to the next pharmacy.

### AC-20 (US-20) Pharmacy dashboard
- **Given** an approved pharmacy
- **When** they open the dashboard
- **Then** they see orders, status, and revenue metrics.

### AC-21 (US-21) Bulk inventory update
- **Given** a pharmacy with a stock file
- **When** they import it
- **Then** inventory updates in bulk with a validation summary of successes/errors.

## 6. Payments

### AC-22 (US-22) Secure payment
- **Given** a customer at checkout
- **When** they pay via an integrated provider
- **Then** payment is authorized before order confirmation and no raw card data is stored.

### AC-23 (US-23) Refund
- **Given** an eligible cancellation or failed delivery
- **When** a refund is triggered
- **Then** the refund is processed to the original method and recorded with a reference.

### AC-24 (US-24) Provider settlement
- **Given** completed orders
- **When** settlement runs
- **Then** the pharmacy receives payout net of platform fees with a statement.

### AC-25 (US-25) Financial reports
- **Given** an admin
- **When** they open financial reports
- **Then** transactions and settlements reconcile with provider callbacks.

## 7. Delivery & Tracking

### AC-26 (US-26) Job offers
- **Given** an order ready for dispatch
- **When** the system dispatches
- **Then** nearby available partners receive the job offer and can accept/decline.

### AC-27 (US-27) Navigation
- **Given** an accepted job
- **When** the partner opens it
- **Then** pickup and drop-off locations with navigation are provided.

### AC-28 (US-28) Real-time tracking
- **Given** an out-for-delivery order
- **When** the customer views tracking
- **Then** location updates refresh at least every 10 seconds.

### AC-29 (US-29) Proof of delivery
- **Given** a delivered order (where policy requires)
- **When** the partner completes delivery
- **Then** proof (confirmation/photo/signature) is captured and stored.

### AC-30 (US-30) Earnings
- **Given** a completed delivery
- **When** the partner views earnings
- **Then** the correct fee for the job is recorded and displayed.

## 8. Doctor Appointments

### AC-31 (US-31) Search doctors
- **Given** a customer
- **When** they search by specialty and location
- **Then** matching, verified doctors are listed nearest-first.

### AC-32 (US-32) View profile and slots
- **Given** a selected doctor
- **When** the profile is opened
- **Then** qualifications, fees, reviews, and available slots are displayed.

### AC-33 (US-33) Book/reschedule/cancel
- **Given** an available slot
- **When** the customer books it
- **Then** the slot is reserved and cannot be double-booked; reschedule/cancel is allowed before the cutoff.

### AC-34 (US-34) Reminders
- **Given** a booked appointment
- **When** the reminder window arrives
- **Then** the customer receives a reminder notification.

### AC-35 (US-35) Manage doctor availability
- **Given** a doctor
- **When** they update their calendar
- **Then** only valid, available slots are bookable by patients.

### AC-36 (US-36) Hospital management
- **Given** a hospital admin
- **When** they manage doctors and departments
- **Then** the hospital listing reflects accurate services and affiliations.

## 9. Diagnostics & Labs

### AC-37 (US-37) Search tests/centers
- **Given** a customer
- **When** they search for a test
- **Then** verified centers offering it are listed with pricing where available.

### AC-38 (US-38) Book with preparation
- **Given** a selected test
- **When** the customer books
- **Then** required preparation instructions are shown before confirmation.

### AC-39 (US-39) Result-ready notification
- **Given** a completed test (with provider integration)
- **When** results are ready
- **Then** the customer is notified per provider policy.

### AC-40 (US-40) Lab management
- **Given** a lab operator
- **When** they manage the catalog and bookings
- **Then** availability and bookings are updated accurately.

## 10. Diaspora Ordering

### AC-41 (US-41) Order for family
- **Given** a diaspora customer
- **When** they select a beneficiary and delivery address in Ethiopia
- **Then** the order is created against that beneficiary.

### AC-42 (US-42) Pay from abroad
- **Given** a diaspora checkout
- **When** they pay via a supported cross-border method
- **Then** payment is authorized and converted/recorded in ETB.

### AC-43 (US-43) Proof of delivery to beneficiary
- **Given** a delivered diaspora order
- **When** delivery completes
- **Then** proof of delivery is available to the diaspora customer.

## 11. Administration & Compliance

### AC-44 (US-44) Verify licenses
- **Given** a provider application
- **When** an admin reviews the license
- **Then** they can approve (activating the provider) or reject with a reason, all logged.

### AC-45 (US-45) Suspend non-compliant providers
- **Given** a provider with an expired/invalid license or breach
- **When** the admin suspends them (or the system auto-suspends)
- **Then** the provider can no longer transact until resolved.

### AC-46 (US-46) Dispute and refund handling
- **Given** a raised dispute
- **When** the admin resolves it
- **Then** the outcome (including any refund) is recorded and parties notified.

### AC-47 (US-47) Dashboards and audit logs
- **Given** an admin
- **When** they open monitoring tools
- **Then** they see KPIs and an immutable audit trail of sensitive actions.

### AC-48 (US-48) Regulator audit access
- **Given** an authorized regulator
- **When** they access compliance records
- **Then** they can read/audit the relevant records without modifying them.

## 12. Definition of Done (Global)
A story is Done when: all acceptance criteria pass; relevant business rules are enforced; applicable NFRs (security, performance, privacy) are met; the feature is documented; and it passes QA, security review (where applicable), and stakeholder acceptance.
