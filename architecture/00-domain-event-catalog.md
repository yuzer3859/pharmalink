# PharmaLink Ethiopia — Domain Event Catalog

**Purpose:** The authoritative catalog of **domain events** emitted and consumed across modules. These are the **inter-module contracts** — locking them down before implementation prevents integration drift. All events are published reliably via the **outbox pattern** and consumed **idempotently** (see `00-shared-conventions.md` §8).

**Event envelope (all events share this shape):**
```
{ "eventId": "uuid",            // dedup key for idempotent consumers
  "eventType": "OrderPlaced",
  "occurredAt": "ISO-8601 UTC",
  "aggregateType": "Order",
  "aggregateId": "uuid",
  "version": 1,                 // aggregate/event version for ordering
  "payload": { ... },           // non-sensitive fields only
  "correlationId": "requestId" }
```

> **Privacy:** payloads carry **identifiers and non-sensitive fields only** — never clinical content, card data, or PII beyond what a consumer needs. Consumers fetch details via ports under access control.

---

## 1. Event Index by Producer

### Module 01 — Identity
| Event | Payload (key fields) | Consumers |
| --- | --- | --- |
| `UserRegistered` | userId, role, locale | 02 (create profile), 13 (welcome/OTP) |
| `UserVerified` | userId, method (FAYDA/PHONE/EMAIL) | 04/09/10 (activation gates) |
| `ProviderApproved` | organizationId, type | 04, 09, 10 (activate eligibility), 13, 16 |
| `ProviderRejected` | organizationId, reason | 13, 16 |
| `LicenseExpired` | organizationId | 04, 09 (auto-suspend), 13, 16 |
| `AccountSuspended` / `AccountReactivated` | userId, reason | 04/08/09/10 (halt/resume), 13, 16 |
| `SessionsRevoked` | userId | (clients) |

### Module 02 — Profiles
| Event | Payload | Consumers |
| --- | --- | --- |
| `BeneficiaryAdded` | ownerUserId, beneficiaryId, relation | 12 (records linkage) |
| `PreferencesUpdated` | userId, notificationPrefs | 13 (cache prefs) |
| `AddressAdded` | userId, addressId, geo | 06/08/11 (delivery/collection) |

### Module 03 — Catalog
| Event | Payload | Consumers |
| --- | --- | --- |
| `ProductCreated` / `ProductUpdated` | productId, type, classification | 14 (index), 04 (listing refresh) |
| `ProductClassificationChanged` | productId, rx, controlledSchedule | 04, 05 (gate rules), 16 (audit) |
| `ProductMerged` | sourceId, targetId | 04 (relink listings), 14 |
| `ProductProposalApproved` | proposalId, productId, orgId | 04, 13 |

### Module 04 — Pharmacy & Inventory
| Event | Payload | Consumers |
| --- | --- | --- |
| `PharmacyActivated` / `PharmacySuspended` | pharmacyId | 14 (eligibility flag), 05/06 (re-match), 13, 16 |
| `ListingCreated` / `ListingDisabled` | listingId, productId, branchId | 14 (index) |
| `PriceChanged` | listingId, oldPrice, newPrice | 14 (index), 15/analytics |
| `StockReceived` | listingId, batchId, quantity, expiryDate | 14 (availability doc) |
| `StockReserved` / `StockReleased` / `StockDispatched` | listingId, qty, orderId | 06 (saga), 05 |
| `StockChanged` | listingId, sellable | ⏸ Not emitted in Slice 1 (module-04 spec §9) — `StockReceived`/`StockReserved`/`StockReleased`/`StockDispatched` already carry the quantity deltas Module 14's projection needs; revisit if a dedicated cache-invalidation signal is needed. |
| `BatchNearExpiry` / `StockLow` | listingId | ⏸ Deferred — Slice 1 does not emit (depends on Module 13 alerting, not yet built; module-04 spec §0.2/§9) |

### Module 05 — Prescription & Matching
| Event | Payload | Consumers |
| --- | --- | --- |
| `PrescriptionUploaded` | prescriptionId, beneficiaryId | 13 |
| `PrescriptionApproved` | prescriptionId, lines | 06 (proceed), 12 (record), 13 |
| `PrescriptionRejected` | prescriptionId, reason | 06 (cancel/refund Rx line), 13 |
| `MedicineDispensed` | prescriptionLineId, orderId, qty | 04 (reconcile), 16 |
| `OrderMatched` | matchRequestId, orderId, result | 06 |
| `RematchTriggered` / `MatchFailed` | matchRequestId | 06 (rematch/cancel), 13 |

### Module 06 — Orders
| Event | Payload | Consumers |
| --- | --- | --- |
| `OrderPlaced` | orderId, customerId, totals | 07 (authorize), 13 |
| `OrderPaid` | orderId, paymentId | 04 (confirm reservation), 05 (verify), 13 |
| `OrderAccepted` | orderId, fulfillmentId, pharmacyId | 13 |
| `OrderReady` | orderId, fulfillmentId | 08 (create delivery job), 13 |
| `OrderDispatched` / `OrderDelivered` | orderId | 13, 15 (enable review) |
| `OrderCompleted` | orderId | 07 (accrue payable), 15, analytics |
| `OrderCancelled` | orderId, reason | 04 (release), 07 (refund), 08 (cancel job), 13 |
| `SubstitutionProposed` | orderId, lineId | 13 (consent request) |

### Module 07 — Payment
| Event | Payload | Consumers |
| --- | --- | --- |
| `PaymentAuthorized` | paymentId, orderId | 06 (confirm) |
| `PaymentCaptured` | paymentId, orderId, fee | 06, 16 |
| `PaymentFailed` | paymentId, orderId, reason | 06 (compensate), 13 |
| `PaymentRefunded` | paymentId, amount | 06, 13, 16 |
| `WalletCredited` / `WalletDebited` | userId, amount | 13 |
| `CouponRedeemed` / `CouponReversed` | couponId, userId, orderId, discountAmount | 06 (saga compensation), 16 (promotion reporting) |
| `SettlementPaid` | settlementId, pharmacyId, net | 04/09 (dashboard), 13, 16 |
| `FraudFlagged` | paymentId, rule | 16 |

### Module 08 — Delivery
| Event | Payload | Consumers |
| --- | --- | --- |
| `JobCreated` / `JobAssigned` | jobId, orderId, driverId | 06 (status), 13 |
| `JobOffered` | jobId, offerId, orderId, driverId, round, expiresAt | 13 (FR-NOT-07 driver push) |
| `OrderPickedUp` | jobId, orderId | 06 (→ DISPATCHED) |
| `EnRoute` | jobId | 06, tracking |
| `OrderDelivered` (delivery) | jobId, orderId, podRef | 06 (→ DELIVERED), 13, 15 |
| `DeliveryFailed` | jobId, reason | 06 (refund/return), 13 |
| `EarningAccrued` | driverId, jobId, amount | 07 (settlement) |
| `CodCollected` | jobId, amount | 07 (reconcile) |
| `CodRemitted` | collectionId, jobId, orderId, driverId, expected/collected/remitted amounts, currency, reference | 07 (reconcile) |
| `CodReconciled` | collectionId, jobId, orderId, driverId, expected/collected/remitted amounts, currency, outcome | 07 (settlement input) |
| `CodCorrectionRecorded` | correctionId, collectionId, jobId, orderId, driverId, type, original/corrected value, currency, reason | 07 (restated COD figures) |

### Module 09 — Provider Directory
| Event | Payload | Consumers |
| --- | --- | --- |
| `ProviderActivated` / `ProviderSuspended` | providerId | 14, 10/11 (publishing), 13, 16 |
| `ServiceOfferingAdded` / `Updated` | providerId, serviceId | 14, 11 |
| `DepartmentAdded` | providerId, departmentId | 10 (affiliations) |

### Module 10 — Doctor & Appointment
| Event | Payload | Consumers |
| --- | --- | --- |
| `DoctorProfileUpdated` | doctorId, specialty | 14 (index), 09 (affiliation nav) |
| `SlotChanged` | doctorId, slotId, status | 14 (availability) |
| `AppointmentConfirmed` | appointmentId, type | 12 (create session if telemedicine), 13 |
| `AppointmentCancelled` | appointmentId, reason | 07 (refund), 13 (waitlist notify) |
| `AppointmentCompleted` | appointmentId | 15 (enable review), 12 (record) |
| `NoShowRecorded` | appointmentId | 07 (fee), 13 |

### Module 11 — Diagnostics
| Event | Payload | Consumers |
| --- | --- | --- |
| `BookingConfirmed` | bookingId, mode | 08 (home collection job), 13 |
| `SampleCollected` | bookingId | 13 |
| `ResultReady` | bookingItemId, healthRecordId | 12 (attach record), 13 |
| `ResultAmended` | resultId, version | 12, 13 |
| `BookingCancelled` | bookingId, reason | 07 (refund), 13 |

### Module 12 — Consultation & Records
| Event | Payload | Consumers |
| --- | --- | --- |
| `SessionCreated` / `SessionStarted` / `SessionEnded` | sessionId, appointmentId | 10, 13 |
| `EPrescriptionIssued` | ePrescriptionId, prescriptionId | 05 (register APPROVED Rx), 13 |
| `RecordAdded` | healthRecordId, type, beneficiaryId | 14? (no — private), analytics(anon) |
| `ConsentGranted` / `ConsentRevoked` | ownerId, granteeId, scope | 13, 16 |

### Module 13 — Notifications
| Event | Payload | Consumers |
| --- | --- | --- |
| `NotificationSent` / `Delivered` / `Failed` | notificationId, channel | 16 (delivery dashboards) |
| `PreferenceUpdated` | userId, category, channel | (internal) |

### Module 14 — Search
| Event | Payload | Consumers |
| --- | --- | --- |
| (consumer-only, emits none domain-facing) | — | — |

### Module 15 — Reviews
| Event | Payload | Consumers |
| --- | --- | --- |
| `ReviewPublished` / `ReviewRemoved` | reviewId, subjectType, subjectId, score | 14 (rating signal), 04/09/10 (rating_avg), 16 |
| `RatingAggregateUpdated` | subjectType, subjectId, avg, count | 14, dashboards |
| `ReviewReported` | reviewId, reason | 16 (moderation queue) |

### Module 16 — Admin
| Event | Payload | Consumers |
| --- | --- | --- |
| `ConfigChanged` | namespace, key, version, changedBy | all (cache invalidate via IConfigPort) |
| `FeatureFlagToggled` | key, enabled, changedBy | all |
| `DisputeResolved` | caseId, action | 06/07/08 (effects via ports), 13 |
| `AdminActionExecuted` | actor, action, target | (audit — already chained) |

---

## 2. Key Event Chains (end-to-end)

**Order fulfillment (Phase 1):**
```
OrderPlaced(06) → PaymentAuthorized(07) → OrderPaid(06)
  → [Rx items] PrescriptionApproved(05) → OrderAccepted(06)
  → OrderReady(06) → JobCreated/Assigned(08) → OrderPickedUp(08) → OrderDelivered(08)
  → OrderDelivered(06) → OrderCompleted(06) → PaymentCaptured(07) → ReviewPublished(15) → rating signal(14)
```

**Telemedicine → e-prescription → purchase (Phase 2 ↔ Phase 1):**
```
AppointmentConfirmed(10, telemedicine) → SessionCreated(12) → SessionEnded(12)
  → EPrescriptionIssued(12) → [registers APPROVED Rx in 05]
  → customer orders meds → OrderPlaced(06) → (Rx gate passes) → ... fulfillment chain
```

**Diagnostics with home collection:**
```
BookingConfirmed(11, HOME) → JobCreated(08, collection) → SampleCollected(11)
  → ResultReady(11) → RecordAdded(12) → notify(13)
```

**License expiry compliance:**
```
LicenseExpired(01) → PharmacySuspended(04)/ProviderSuspended(09)
  → search eligibility flag off(14) → in-flight orders re-matched(05/06) → notify(13)
```

---

## 3. Contract Rules

1. **Additive evolution only** — add fields/events; never break existing payload fields (version bump for breaking changes).
2. **Idempotent consumers** — dedup by `eventId`; handle out-of-order via `version`.
3. **No sensitive data in payloads** — identifiers + non-sensitive fields only; fetch details via ports under access control.
4. **Outbox-published** — emitted in the same transaction as the state change; relayed reliably.
5. **Naming** — `PastTenseNoun+Verb` (e.g., `OrderPlaced`, `PaymentCaptured`); aggregate-scoped.
6. **Consumers depend on events + ports, not tables** — preserves bounded-context isolation and future extraction.

---

*End of domain event catalog. This is the inter-module contract surface; changes require review against all listed consumers.*
