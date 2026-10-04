# Module 8 — Delivery Management & Tracking (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 08 — Delivery Management & Tracking (Delivery jobs, driver assignment, real-time tracking, proof of delivery, earnings, COD)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity/driver verification), 02 (Address), 04 (Pharmacy/branch), 06 (Orders), 07 (Payment/COD, earnings settlement). Consumed by: Orders (status sync), Notification, Driver app (Flutter).
**Traceability:** FR-DEL-01..10, FR-NOT-07, FR-PERF-04, BRULE-09, BRULE-19, BRULE-27, BRULE-28, BRULE-29, BRULE-30, NFR-PERF-04, NFR-AVAIL, NFR-LOC-04, NFR-AUDIT

> Single source of truth for the Delivery Management & Tracking bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This module manages the **last mile**: turning a *ready* order into a **delivery job**, assigning it to the best available **driver**, providing **real-time tracking**, capturing **proof of delivery**, and recording **driver earnings** (and reconciling COD cash back to Payment).

**Boundary.** Delivery owns the **delivery job lifecycle, driver availability/location, and dispatch**. It does **not** own order state (Module 6) — it emits events that advance the order (dispatched, delivered). It does **not** own money (Module 7) — it reports earnings and COD collection for settlement. Drivers as *identities* are owned by Module 1 (verification, BRULE-09); Delivery owns their *operational* profile (availability, vehicle, current location).

**Primary objectives**
- Create a **delivery job** when a pharmacy marks an order ready (FR-DEL-01, BRULE-27).
- **Dispatch** jobs to available nearby drivers; accept/decline; **reassign** if unavailable (FR-DEL-02/03/08, BRULE-19).
- Provide **pickup/dropoff navigation** and **real-time tracking** to the customer via WebSockets (FR-DEL-04/05/07, NFR-PERF-04).
- Capture **proof of delivery** where required (FR-DEL-06, BRULE-29).
- Compute **delivery fees by distance/zone** and record **driver earnings** per completed job (FR-DEL-09/10).
- Enforce **concurrent-job limits** (BRULE-28) and **cold-chain handling** flags (BRULE-30).
- Notify drivers of new assignments (FR-NOT-07).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-DEL-01 | A delivery job is created when an order is ready for dispatch. | FR-DEL-01, BRULE-27 |
| BR-DEL-02 | Jobs are dispatched to available nearby delivery partners. | FR-DEL-02 |
| BR-DEL-03 | Drivers can accept or decline jobs. | FR-DEL-03 |
| BR-DEL-04 | Pickup and drop-off locations + navigation are provided. | FR-DEL-04 |
| BR-DEL-05 | Real-time tracking of delivery is provided to the customer. | FR-DEL-05, NFR-PERF-04 |
| BR-DEL-06 | Proof of delivery is captured where policy mandates. | FR-DEL-06, BRULE-29 |
| BR-DEL-07 | Delivery status updates (picked up, en route, delivered) are supported. | FR-DEL-07 |
| BR-DEL-08 | A job is reassigned if a partner becomes unavailable. | FR-DEL-08, BRULE-19 |
| BR-DEL-09 | Delivery fees are calculated by distance/zone. | FR-DEL-09 |
| BR-DEL-10 | Driver earnings per completed job are recorded. | FR-DEL-10 |
| BR-DEL-11 | Drivers must be verified/onboarded before accepting jobs. | BRULE-09 |
| BR-DEL-12 | A driver may hold a limited number of concurrent active jobs. | BRULE-28 |
| BR-DEL-13 | Temperature-sensitive medicines are flagged and handled per storage requirements. | BRULE-30 |
| BR-DEL-14 | Drivers are notified of new job assignments. | FR-NOT-07 |

---

## 3. Functional Requirements (Module Features)

### 3.1 Driver Operational Profile
- **F-DRV-01** Driver operational profile: vehicle type, service area, verification status (from Module 1, BRULE-09).
- **F-DRV-02** Availability toggle (online/offline); shift status.
- **F-DRV-03** Live location updates (from driver app) while online.
- **F-DRV-04** Concurrent job limit enforcement (configurable, BRULE-28).

### 3.2 Job Creation & Dispatch
- **F-JOB-01** Create delivery job on `OrderReady`/fulfillment ready (BRULE-27); one job per fulfillment (supports split orders → multiple jobs).
- **F-JOB-02** Job carries pickup (branch), dropoff (address snapshot), items summary, cold-chain flag (BRULE-30), COD flag/amount.
- **F-JOB-03** **Dispatch algorithm**: find eligible, available, nearby drivers under concurrent limit; offer job (FR-DEL-02).
- **F-JOB-04** Driver **accept/decline** with offer TTL; on decline/timeout → offer next candidate (FR-DEL-03/08).
- **F-JOB-05** **Reassign** if assigned driver goes offline/unavailable before pickup (BRULE-19, FR-DEL-08).
- **F-JOB-06** Batch/stacked deliveries (optional/future) within concurrent limit.

### 3.3 Fulfillment & Status
- **F-STS-01** Status lifecycle: `CREATED → OFFERED → ASSIGNED → ARRIVED_PICKUP → PICKED_UP → EN_ROUTE → ARRIVED_DROPOFF → DELIVERED → COMPLETED`; branches `CANCELLED`, `REASSIGNING`, `FAILED`.
- **F-STS-02** Navigation deep-links / route to pickup then dropoff (FR-DEL-04).
- **F-STS-03** Status updates emitted to Orders (dispatched/en route/delivered) (FR-DEL-07).
- **F-STS-04** Proof of delivery: recipient confirmation / signature / photo (FR-DEL-06, BRULE-29).
- **F-STS-05** Failed delivery handling (recipient absent) → retry/return policy → Orders/refund hook.

### 3.4 Real-Time Tracking
- **F-TRK-01** Driver app pushes location; server relays to customer via **WebSocket** channel scoped to the order (FR-DEL-05).
- **F-TRK-02** ETA computation/update (≤10s refresh interval, NFR-PERF-04).
- **F-TRK-03** Customer sees live map position, driver info, ETA; graceful degradation on poor connectivity (NFR-LOC-04).

### 3.5 Fees & Earnings
- **F-FEE-01** Compute delivery fee by distance/zone at job creation (FR-DEL-09) — provided to Orders pricing.
- **F-ERN-01** Record driver earning per completed job (base + distance + incentives) (FR-DEL-10).
- **F-ERN-02** Driver earnings ledger + payout via Module 7 settlement.
- **F-COD-01** COD: driver collects cash on delivery; record collection; reconcile to Payment (Module 7).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Real-time** | Tracking ≤10s updates (NFR-PERF-04) | WebSocket gateway; Redis pub/sub fan-out; location writes throttled + last-known cached. |
| **Scalability** | Many concurrent drivers/jobs (NFR-SCAL) | Stateless WS nodes + Redis adapter; geospatial index (geohash/PostGIS) for nearest-driver. |
| **Reliability** | No lost jobs; reassign on failure (NFR-AVAIL) | Job state machine + offer TTL sweeper; idempotent status updates; outbox to Orders. |
| **Connectivity** | Intermittent networks (NFR-LOC-04) | Offline-tolerant driver app; buffered location; idempotent status posts. |
| **Auditability** | Delivery + PoD + earnings traced (NFR-AUDIT) | Immutable status history + earnings ledger + PoD artifacts. |
| **Safety/Compliance** | Cold-chain handling (BRULE-30); PoD (BRULE-29) | Cold-chain flag surfaced to driver; PoD required per policy before DELIVERED. |
| **Fairness** | Fair, optimized dispatch (Vision) | Distance + fairness scoring; concurrent-limit + rotation to spread jobs. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **DeliveryJob** (aggregate root) — one delivery task (per order fulfillment): pickup, dropoff, items, status, assignment.
- **JobOffer** (entity) — an offer of a job to a specific driver with TTL + response.
- **DriverProfile** (aggregate root) — operational driver state: availability, vehicle, concurrent count.
- **DriverLocation** (value/hot state) — last-known geo point + timestamp (Redis-primary).
- **DeliveryStatusHistory** (immutable) — status transitions.
- **ProofOfDelivery** (entity) — confirmation type + artifact ref (photo/signature) + timestamp.
- **DriverEarning** (ledger entry) — earning accrued per completed job.
- **CodCollection** (record) — cash collected for COD orders.

### 5.2 Value Objects
- `GeoPoint`, `DeliveryStatus`, `OfferStatus` (OFFERED|ACCEPTED|DECLINED|EXPIRED), `VehicleType`, `Availability` (ONLINE|OFFLINE|BUSY), `DeliveryFee` (base+distance+zone), `Eta`, `PodType` (CONFIRMATION|SIGNATURE|PHOTO), `ColdChainFlag`.

### 5.3 Invariants
- A job is created **only** when its order/fulfillment is `READY_FOR_PICKUP` (BRULE-27).
- Only **verified, onboarded** drivers (Module 1, BRULE-09) may receive offers/accept.
- A driver's **active jobs ≤ concurrent limit** (BRULE-28) — enforced at accept time.
- A job reaches `DELIVERED` only with **valid PoD** where policy requires it (BRULE-29).
- Cold-chain jobs (BRULE-30) carry the flag from the order/catalog; surfaced to driver; (future: handling attestation).
- Every status change appends to history + emits an event (Orders sync); status posts are **idempotent** (retry-safe, NFR-LOC-04).
- Earnings accrue **once** per completed job (idempotent), recorded in the driver earnings ledger.

**Design rationale — job per fulfillment.** Because an order can split across pharmacies (Module 6 `fulfillments`), delivery is modeled **per fulfillment**, not per order. Each pickup location = one job = one driver route. This cleanly supports single- and multi-pharmacy orders and maps to independent tracking channels.

---

## 6. Dispatch Algorithm (FR-DEL-02/03/08)

**Goal:** assign each job to a good driver quickly and fairly.

1. **Candidate query** — verified, `ONLINE`, under concurrent limit, within pickup service radius; sorted by distance to pickup (geospatial index).
2. **Scoring** — `score = w_dist·proximity + w_fair·(inverse recent-job-count) + w_rating·rating` — balances speed and fairness (Vision: "fair and optimized delivery opportunities").
3. **Offer** — send top candidate a `JobOffer` with **TTL** (e.g., 30s) via FCM + WebSocket (FR-NOT-07).
4. **Response** — accept → `ASSIGNED` (enforce concurrent limit atomically); decline/timeout → offer next candidate.
5. **Exhaustion** — no acceptor after N rounds → escalate (widen radius / notify ops / hold) and inform Orders.
6. **Reassign** — assigned driver goes offline/cancels pre-pickup → `REASSIGNING` → re-run dispatch (BRULE-19).

**Design rationale.** Sequential offer-with-TTL (vs broadcast-to-all) prevents race conditions on acceptance and respects concurrent limits, while fairness scoring avoids starving drivers. The algorithm is a pure domain service over Redis-cached driver locations/availability — testable and swappable (e.g., future batch/stacked optimization) behind an interface.

---

## 7. Real-Time Tracking Architecture (FR-DEL-05, NFR-PERF-04)

- **Driver app** posts location every few seconds while `ONLINE`/on a job → `POST /delivery/location` (throttled) or WS message.
- **Server** writes last-known location to **Redis** (hot, TTL) and publishes to a **Redis pub/sub** channel keyed by `jobId`.
- **WebSocket gateway** (NestJS gateway) subscribes clients (customer app) to their `jobId` channel; fans out location + ETA updates (≤10s, NFR-PERF-04).
- **Horizontal scale** — multiple WS nodes share subscriptions via the **Redis adapter**; any node can serve any client. Location is not persisted per-tick (only periodic snapshots for history/audit) to avoid write amplification.
- **ETA** — computed via mapping adapter (`IRoutingPort`) or heuristic; cached and refreshed.

**Design rationale.** Ephemeral high-frequency location belongs in Redis, not Postgres (write volume + no long-term value). Pub/sub + WS Redis adapter gives horizontal scalability for tracking without sticky sessions (NFR-SCAL, NFR-PERF-04).

---

## 8. Database Design (PostgreSQL via Prisma)

UUID v7 PKs; timestamps. Live location primarily in Redis; Postgres holds jobs, history, PoD, earnings.

**driver_profiles** — operational state (references Module 1 user).
- `id`, `user_id` (unique FK → users, role DRIVER), `vehicle_type`, `plate_number`, `service_area` (jsonb/geo), `availability` (ONLINE|OFFLINE|BUSY), `active_job_count` (derived cache), `max_concurrent` (config), `rating_avg`, `rating_count`, `is_verified` (mirror of Module 1), `last_online_at`, `created_at`, `updated_at`.

**delivery_jobs** — aggregate root (per fulfillment).
- `id`, `order_id` (FK → Module 6), `fulfillment_id` (FK → Module 6), `pharmacy_id`, `branch_id`, `pickup_lat`, `pickup_lng`, `pickup_address` (snapshot), `dropoff_lat`, `dropoff_lng`, `dropoff_address` (snapshot), `assigned_driver_id` (FK → driver_profiles, nullable), `status`, `is_cold_chain` (bool, BRULE-30), `is_cod` (bool), `cod_amount` (nullable), `delivery_fee`, `distance_meters`, `eta_at` (nullable), `picked_up_at`, `delivered_at`, `created_at`, `updated_at`.

**job_offers** — dispatch offers.
- `id`, `job_id` (FK), `driver_id` (FK), `status` (OFFERED|ACCEPTED|DECLINED|EXPIRED), `offered_at`, `expires_at`, `responded_at`, `round` (int).

**delivery_status_history** — immutable transitions.
- `id`, `job_id` (FK), `from_status`, `to_status`, `actor_type` (DRIVER|SYSTEM|ADMIN), `actor_id` (nullable), `reason`, `lat`, `lng`, `created_at`.

**proof_of_delivery** — PoD artifacts (BRULE-29).
- `id`, `job_id` (FK), `type` (CONFIRMATION|SIGNATURE|PHOTO), `artifact_ref` (storage), `recipient_name` (nullable), `captured_at`.

**location_snapshots** — periodic route history (not per-tick).
- `id`, `job_id` (FK), `driver_id` (FK), `lat`, `lng`, `recorded_at`. (Sampled, e.g., every N seconds, for audit/dispute.)

**driver_earnings** — earnings ledger (append-only).
- `id`, `driver_id` (FK), `job_id` (FK), `base`, `distance_component`, `incentive`, `total`, `currency` (ETB), `status` (ACCRUED|SETTLED), `created_at`.

**cod_collections** — cash collected (reconcile to Module 7).
- `id`, `job_id` (FK), `driver_id` (FK), `amount`, `collected_at`, `reconciled` (bool), `reconciled_at`, `settlement_ref` (nullable).

**Relationships**
- `driver_profiles 1—N delivery_jobs / job_offers / driver_earnings / cod_collections`.
- `delivery_jobs 1—N job_offers / status_history / location_snapshots`; `1—1 proof_of_delivery`; `1—1 cod_collection` (if COD).
- References to Orders (order/fulfillment), Pharmacy (branch), Payment (settlement).

**Rationale.** `active_job_count` is a derived cache guarded by the concurrent-limit check at accept time (BRULE-28). Earnings are an **append-only ledger** (consistent with Module 7's philosophy), settled via Payment. Live location is Redis-first; `location_snapshots` keeps a sampled trail for disputes/audit without write amplification.

---

## 9. API Design

Base paths: `/api/v1/delivery` (driver app + internal), `/api/v1/driver`, `/api/v1/tracking` (WS), `/api/v1/admin/delivery`. Bearer auth; driver-scoped. Envelope/errors per Module 1 §14.

### 9.1 Driver operational
- **PUT `/driver/availability`** — `{ status }` (ONLINE/OFFLINE). Requires verified driver (BRULE-09).
- **GET `/driver/profile`** / **PATCH** — vehicle/service area.
- **POST `/delivery/location`** — `{ lat, lng }` (throttled) → updates Redis + snapshots.
- **GET `/driver/jobs`** — active + offered jobs. **GET `/driver/jobs/history`**.
- **GET `/driver/earnings`** — earnings ledger + summary.

### 9.2 Job lifecycle (driver)
- **POST `/delivery/jobs/{id}/accept`** — accept offer (concurrent-limit guarded → `CONCURRENT_LIMIT_REACHED`). → ASSIGNED.
- **POST `/delivery/jobs/{id}/decline`** — decline → re-dispatch.
- **POST `/delivery/jobs/{id}/arrived-pickup`** / **`/picked-up`** — status updates.
- **POST `/delivery/jobs/{id}/en-route`** / **`/arrived-dropoff`**.
- **POST `/delivery/jobs/{id}/deliver`** — `{ podType, artifactRef?, recipientName?, codCollected? }` → validates PoD (BRULE-29) → DELIVERED. Records COD if applicable.
- **POST `/delivery/jobs/{id}/fail`** — `{ reason }` → failed-delivery flow.

### 9.3 Internal (called by Orders on ready)
- **POST `/delivery/jobs`** — `{ orderId, fulfillmentId, pickup, dropoff, items, isColdChain, isCod, codAmount }` → create + dispatch. (BRULE-27)
- **POST `/delivery/jobs/{id}/cancel`** — order cancelled upstream.
- **GET `/delivery/quote`** — `{ pickup, dropoff }` → delivery fee + distance + ETA (for checkout pricing, FR-DEL-09).

### 9.4 Tracking (customer)
- **WS `/tracking/orders/{orderId}`** — subscribe to live driver location + status + ETA (FR-DEL-05). Auth: order ownership.
- **GET `/delivery/jobs/{id}/status`** — REST fallback for status/last-known location.

### 9.5 Admin
- **GET `/admin/delivery/jobs`** — monitor/filter (stuck/unassigned). **POST `/admin/delivery/jobs/{id}/reassign`** — manual reassign. **GET `/admin/delivery/cod-reconciliation`**.

**Representative errors:** `DRIVER_NOT_VERIFIED, CONCURRENT_LIMIT_REACHED, JOB_NOT_FOUND, OFFER_EXPIRED, INVALID_STATE_TRANSITION, POD_REQUIRED, NO_DRIVER_AVAILABLE, JOB_ALREADY_ASSIGNED, RBAC_FORBIDDEN, VALIDATION_ERROR`.

---

## 10. NestJS Folder Structure (Clean Architecture)

```
src/modules/delivery/
  domain/
    entities/            # DeliveryJob, JobOffer, DriverProfile, ProofOfDelivery, DriverEarning,
    │                    # CodCollection, DeliveryStatusHistory
    value-objects/       # GeoPoint, DeliveryStatus, OfferStatus, VehicleType, Availability,
    │                    # DeliveryFee, Eta, PodType, ColdChainFlag
    events/              # JobCreated, JobOffered, JobAssigned, DriverArrivedPickup, OrderPickedUp,
    │                    # EnRoute, OrderDelivered, DeliveryFailed, JobReassigning, EarningAccrued, CodCollected
    enums/               # DeliveryStatus, OfferStatus, Availability, PodType
    repositories/        # IDeliveryJobRepository, IDriverProfileRepository, IOfferRepository,
    │                    # IEarningsRepository, ICodRepository
    services/            # DispatchEngine, DispatchScoring, ConcurrentLimitPolicy, DeliveryStateMachine,
    │                    # DeliveryFeeCalculator, PodPolicy
  application/
    commands/            # CreateDeliveryJob, DispatchJob, AcceptOffer, DeclineOffer, UpdateJobStatus,
    │                    # CompleteDelivery, FailDelivery, ReassignJob, UpdateLocation, AccrueEarning, RecordCod
    queries/             # GetDriverJobs, GetJobStatus, GetEarnings, GetDeliveryQuote, GetLastKnownLocation
    ports/               # ILocationCachePort (Redis), IRealtimePort (WS pub/sub), IRoutingPort (maps/ETA),
    │                    # IOrdersPort(6), IPaymentPort(7), IIdentityPort(1 driver verification),
    │                    # IStoragePort (PoD), INotificationPort, IAuditPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/
    realtime/            # WsRealtimeAdapter (Redis pub/sub), LocationRedisCache
    routing/             # MapRoutingAdapter (ETA/distance) + MockRouting
    scheduling/          # OfferTtlSweeper, StuckJobSweeper, LocationSnapshotSampler
    ports-adapters/      # Orders/Payment/Identity/Notification/Storage adapters
    audit/
  interface/
    ws/                  # TrackingGateway (WebSocket) — subscribe by orderId, fan-out location/ETA
    http/
      controllers/       # DriverController, DeliveryJobController, DeliveryInternalController,
      │                  # TrackingController(REST fallback), AdminDeliveryController
      dtos/ guards/ decorators/ filters/ interceptors/  # IdempotencyInterceptor on status posts
    events/              # on OrderReady(6)→CreateDeliveryJob; on OrderDelivered→notify+earning+order sync
  delivery.module.ts
```

**Rationale.** `DispatchEngine` + `DeliveryStateMachine` are pure domain services. Real-time concerns (Redis, WS) are infrastructure behind `ILocationCachePort`/`IRealtimePort`, keeping domain testable. Cross-module effects (order status, earnings/COD settlement, driver verification) all go through ports.

---

## 11. Sequence Flows

### 11.1 Job Creation → Dispatch (BRULE-27)
```
Orders(6) OrderReady event → CreateDeliveryJob {order, fulfillment, pickup, dropoff, coldChain, cod}
CreateDeliveryJob → DeliveryFeeCalculator (distance/zone) → save Job(CREATED)
CreateDeliveryJob → DispatchJob
DispatchEngine → ILocationCachePort: nearby ONLINE verified drivers under limit
DispatchEngine → DispatchScoring → top candidate → create JobOffer(TTL); Job=OFFERED
DispatchJob → INotificationPort (FCM) + IRealtimePort (WS) notify driver (FR-NOT-07)
```

### 11.2 Accept (concurrent-limit guard, BRULE-28)
```
Driver → POST /delivery/jobs/{id}/accept
AcceptOffer → TX: ConcurrentLimitPolicy: active_job_count < max?  else CONCURRENT_LIMIT_REACHED
AcceptOffer → offer OFFERED→ACCEPTED; Job=ASSIGNED; driver.active_job_count++
AcceptOffer → outbox(JobAssigned) → notify customer; open tracking channel
 (decline/timeout → OfferTtlSweeper → offer next candidate)
```

### 11.3 Real-Time Tracking (FR-DEL-05)
```
Driver app → POST /delivery/location {lat,lng} (throttled)  [or WS msg]
UpdateLocation → ILocationCachePort: set last-known (Redis TTL)
UpdateLocation → IRealtimePort: publish to channel job:{id}
Customer WS (/tracking/orders/{orderId}) ← TrackingGateway fan-out {lat,lng,eta,status}  (≤10s)
LocationSnapshotSampler → periodically persist location_snapshots (audit)
```

### 11.4 Pickup → Deliver (PoD, BRULE-29)
```
Driver → /arrived-pickup → /picked-up  → Job=PICKED_UP → outbox(OrderPickedUp) → Orders DISPATCHED
Driver → /en-route → Job=EN_ROUTE → Orders OUT_FOR_DELIVERY
Driver → /arrived-dropoff → /deliver {podType, artifact, codCollected}
CompleteDelivery → PodPolicy: PoD present if required?  else POD_REQUIRED
CompleteDelivery → save ProofOfDelivery; Job=DELIVERED; driver.active_job_count--
CompleteDelivery → AccrueEarning (idempotent) → DriverEarning(ACCRUED)
CompleteDelivery → if COD → RecordCod → CodCollection (reconcile later via Payment)
CompleteDelivery → outbox(OrderDelivered) → Orders DELIVERED → notify customer
```

### 11.5 Reassign (BRULE-19)
```
Driver offline / cancels pre-pickup / StuckJobSweeper
ReassignJob → Job=REASSIGNING; release driver slot; DispatchJob (exclude prior driver)
 none available → NO_DRIVER_AVAILABLE → escalate ops / notify Orders
```

---

## 12. Error Handling

Reuses Module 1 §14. Status posts are **idempotent** (duplicate `/picked-up` returns current state, not error — NFR-LOC-04). Key codes: `DRIVER_NOT_VERIFIED` (BRULE-09), `CONCURRENT_LIMIT_REACHED` (BRULE-28), `OFFER_EXPIRED`, `POD_REQUIRED` (BRULE-29), `NO_DRIVER_AVAILABLE` (escalation), `JOB_ALREADY_ASSIGNED` (race on offer), `INVALID_STATE_TRANSITION` (state-machine guard), `RBAC_FORBIDDEN`.

---

## 13. Logging & Auditing

Reuses hash-chained `audit_logs`; `delivery_status_history`, `driver_earnings`, `cod_collections` are their own trails. **Must-log:** job created, offered (to whom), assigned, every status transition (with geo), PoD captured (type + artifact ref), delivery failed (reason), reassignment (reason), earning accrued, COD collected + reconciled. Operational logs track dispatch latency, offer acceptance rate, tracking fan-out load (NFR-PERF-04). Sampled location snapshots retained per dispute-resolution policy.

---

## 14. Future Scalability & Evolution

- **Tracking scale** — WS nodes + Redis pub/sub adapter scale horizontally; last-known in Redis; consider dedicated geospatial store (PostGIS/Redis Geo) for nearest-driver at volume.
- **Dispatch evolution** — pluggable `DispatchScoring` allows batch/stacked deliveries, zone-based pre-positioning, and ML-based ETA/assignment later (behind the same interface).
- **Reliability** — outbox to Orders + idempotent status posts + TTL/stuck sweepers ensure no lost/stuck jobs (NFR-AVAIL).
- **COD reconciliation** — `cod_collections` feed Module 7 settlement (driver remits cash; platform reconciles).
- **Driver incentives/surge** — fee/earning components are configurable; add surge/incentive rules without schema change.
- **Extraction-ready** — depends on Orders/Payment/Identity via ports and events; the tracking gateway + dispatch engine can become a dedicated Delivery service (WS scaling is independent).

---

## Open Questions for Product/Compliance
1. **PoD policy** — which orders require photo/signature vs simple confirmation (BRULE-29)? Controlled/cold-chain always photo?
2. **Concurrent job limit** — default `max_concurrent` per driver (BRULE-28); single vs stacked deliveries at launch?
3. **Delivery fee model** — flat/zone/distance (FR-DEL-09) — must align with Module 6 `PricingCalculator` and Module 7 accounting.
4. **Driver earnings model** — base + per-km + incentives; who funds it (platform vs delivery fee split)?
5. **COD cash handling** — remittance cadence and reconciliation flow with Payment (Module 7 open Q5).
6. **Cold-chain enforcement** — is a handling attestation/temperature log required for BRULE-30 at launch, or flag-only?

---

**End of Module 8 design.** Awaiting your approval to proceed. Recommended next module: **Provider Directory** (hospitals, clinics, diagnostic centers, labs) — Phase 2 healthcare services, the foundation for Doctor & Appointment and Diagnostics modules (FR-HOSP, FR-LAB, BRULE-06/07).
