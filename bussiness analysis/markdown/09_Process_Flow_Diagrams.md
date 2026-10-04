# PharmaLink Ethiopia — Process Flow Diagrams

**Document Type:** Process Flow Diagrams (Narrative + Swimlane + Decision Tables)
**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Version:** 1.0
**Prepared by:** Senior Business Analyst
**Status:** Draft for Review

## 1. Purpose and Notation
This document describes the platform's key business processes. Because these are delivered in a text document, each flow is expressed as: (a) a **step-by-step sequence**, (b) a **swimlane table** showing actor responsibilities, and (c) **decision points** with outcomes. These can be redrawn as BPMN/flowchart diagrams by the design team. Arrow notation `->` denotes sequence; `<>` denotes a decision.

## 2. Process 1 — Medicine Order & Delivery (Core Flow)

### 2.1 Step Sequence
1. Customer searches for a medicine.
2. System shows nearby pharmacies with stock.
3. `<>` Is the medicine prescription-only (Rx)?
   - Yes -> Customer uploads/captures prescription -> Pharmacist verifies.
   - No -> Proceed to cart.
4. `<>` Prescription approved?
   - No -> Customer notified with reason -> Flow ends or customer edits order.
   - Yes -> Proceed to cart.
5. Customer adds items to cart and selects beneficiary/address.
6. Customer pays; system authorizes payment.
7. `<>` Payment authorized?
   - No -> Order not created; customer retries.
   - Yes -> Order created and matched to best licensed pharmacy.
8. Pharmacy accepts and prepares order.
9. `<>` Pharmacy accepts?
   - No -> System re-matches to next pharmacy (repeat step 8).
   - Yes -> Pharmacy marks order ready.
10. System creates delivery job; dispatches to nearby partner.
11. Delivery partner accepts, picks up, and delivers with tracking.
12. Delivery confirmed (proof of delivery). Order completed.
13. System settles pharmacy payout and prompts customer for rating.

### 2.2 Swimlane Table
| Step | Customer | System | Pharmacist/Pharmacy | Delivery Partner |
| --- | --- | --- | --- | --- |
| Search & select | Searches, selects | Returns in-stock, licensed pharmacies | — | — |
| Prescription | Uploads Rx | Stores, routes to pharmacist | Verifies/approves/rejects | — |
| Payment | Pays | Authorizes payment | — | — |
| Order match | — | Matches to best pharmacy | Accepts/prepares/marks ready | — |
| Delivery | Tracks | Dispatches job, tracks | Hands over parcel | Accepts, picks up, delivers |
| Completion | Rates | Settles payout, logs | Receives settlement | Records earnings |

### 2.3 Key Decisions
| Decision | Yes | No |
| --- | --- | --- |
| Rx required? | Require verified prescription | Proceed to cart |
| Prescription approved? | Continue order | Notify & stop/edit |
| Payment authorized? | Create order | Retry, no order |
| Pharmacy accepts? | Fulfill | Re-match |

## 3. Process 2 — Prescription Verification
### 3.1 Step Sequence
1. Customer uploads prescription (image/PDF/camera).
2. System encrypts and stores it, adds to pharmacist queue.
3. Pharmacist opens item and reviews legibility, validity, and dosage.
4. `<>` Valid and within validity period?
   - No -> Reject with documented reason -> Notify customer -> Log.
   - Yes -> Approve -> Link to eligible order items -> Notify customer -> Log.
5. Approved prescription usage is tracked to prevent over-dispensing.

### 3.2 Swimlane Table
| Step | Customer | System | Pharmacist |
| --- | --- | --- | --- |
| Upload | Provides Rx | Encrypts, queues | — |
| Review | — | Presents details | Assesses validity |
| Decision | Receives outcome | Logs, links Rx | Approves/rejects with reason |

## 4. Process 3 — Provider Onboarding & License Verification
### 4.1 Step Sequence
1. Provider (pharmacy/doctor/hospital/lab/rider) registers.
2. Provider uploads license/credentials.
3. System places application in admin verification queue.
4. Admin reviews credentials against issuing authority records.
5. `<>` Credentials valid?
   - No -> Reject with reason -> Notify -> Log.
   - Yes -> Activate provider -> Notify -> Log.
6. System monitors license expiry; auto-suspends on expiry until renewed.

### 4.2 Swimlane Table
| Step | Provider | System | Admin |
| --- | --- | --- | --- |
| Apply | Registers, uploads | Queues application | — |
| Verify | — | Presents documents | Validates credentials |
| Decision | Receives status | Activates/suspends, logs | Approves/rejects |
| Monitor | Renews license | Tracks expiry, auto-suspends | Reviews flags |

## 5. Process 4 — Doctor Appointment Booking
### 5.1 Step Sequence
1. Customer searches doctors by specialty/location/hospital.
2. Customer views profile and available slots.
3. Customer selects a slot and books.
4. `<>` Slot still available (no race/double-book)?
   - No -> Prompt to choose another slot.
   - Yes -> Reserve slot -> Collect fee (if applicable) -> Confirm.
5. System sends confirmation and later a reminder.
6. `<>` Customer needs change?
   - Reschedule/cancel before cutoff -> Update slot availability.
7. Appointment attended; status updated; optional review.

### 5.2 Swimlane Table
| Step | Customer | System | Doctor/Hospital |
| --- | --- | --- | --- |
| Search | Searches | Lists verified doctors | Maintains profile |
| Book | Selects slot | Locks slot, prevents double-book | Publishes availability |
| Confirm | Pays (if applicable) | Confirms, reminds | — |
| Attend | Attends/reviews | Updates status | Sees booking |

## 6. Process 5 — Diagnostic / Lab Test Booking
### 6.1 Step Sequence
1. Customer searches for a test or center.
2. Customer compares centers (price, distance, availability).
3. Customer books a slot.
4. System displays required preparation instructions before confirmation.
5. Customer confirms; receives confirmation and reminder.
6. Test performed by center.
7. `<>` Results integration available?
   - Yes -> Notify customer when results are ready.
   - No -> Customer collects results per provider policy.

### 6.2 Swimlane Table
| Step | Customer | System | Diagnostic Center |
| --- | --- | --- | --- |
| Search | Searches, compares | Lists verified centers/tests | Maintains catalog |
| Book | Books slot | Shows prep, confirms, reminds | Confirms availability |
| Perform | Attends | Records booking | Conducts test |
| Results | Notified/collects | Notifies (if integrated) | Releases results per policy |

## 7. Process 6 — Payment & Settlement
### 7.1 Step Sequence
1. Customer initiates payment at checkout (local or cross-border).
2. System requests authorization from payment provider.
3. `<>` Authorized?
   - No -> Order not created; customer retries.
   - Yes -> Record transaction; create order.
4. On completion, system calculates provider payout net of fees.
5. System settles payout and generates statements.
6. `<>` Refund needed (cancellation/failed delivery/dispute)?
   - Yes -> Process refund to original method; log reference.

### 7.2 Swimlane Table
| Step | Customer | System | Payment Provider | Provider (Pharmacy/etc.) |
| --- | --- | --- | --- | --- |
| Pay | Initiates | Requests auth | Authorizes/declines | — |
| Record | — | Records txn, creates order | Confirms via callback | Receives order |
| Settle | — | Computes payout | Transfers funds | Receives settlement |
| Refund | Receives refund | Initiates refund, logs | Processes refund | Adjusts as needed |

## 8. Process 7 — Delivery Dispatch & Tracking
### 8.1 Step Sequence
1. Pharmacy marks order ready.
2. System creates a delivery job and dispatches to nearby available partners.
3. `<>` Partner accepts?
   - No -> Offer to next partner (repeat).
   - Yes -> Partner navigates to pickup.
4. Partner picks up; status = en route; customer tracks in real time.
5. Partner delivers; captures proof of delivery.
6. Order marked delivered/completed; partner earnings recorded.

### 8.2 Swimlane Table
| Step | System | Pharmacy | Delivery Partner | Customer |
| --- | --- | --- | --- | --- |
| Ready | Creates job | Marks ready | — | — |
| Dispatch | Offers job | — | Accepts/declines | — |
| Transit | Tracks | Hands parcel | Picks up, delivers | Tracks live |
| Complete | Logs, pays | — | Confirms delivery | Receives order |

## 9. Process 8 — Diaspora Ordering (Variation of Core Flow)
### 9.1 Notes
- Same as the core medicine flow with these differences:
  - Customer is abroad; selects an in-Ethiopia **beneficiary** and delivery address.
  - Payment uses a supported **cross-border** method; amounts recorded in ETB.
  - **Proof of delivery** is surfaced to the diaspora customer for assurance.

## 10. Exception & Escalation Flows (Summary)
| Scenario | Handling |
| --- | --- |
| Prescription rejected | Notify customer with reason; allow re-upload or cancel. |
| No pharmacy can fulfill | Notify customer; refund if already paid. |
| Payment failure | No order created; prompt retry/alternate method. |
| Delivery partner unavailable | Re-dispatch to next partner; escalate if none. |
| Delivery failed/undeliverable | Return to pharmacy; initiate refund per policy. |
| Dispute raised | Route to admin; investigate; resolve with refund/decision; log. |
| Provider license expired | Auto-suspend; block new transactions until renewed. |
