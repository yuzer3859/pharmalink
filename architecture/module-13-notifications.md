# Module 13 — Notifications & Communication (Design Document)

**Product:** PharmaLink Ethiopia — Digital Healthcare Marketplace
**Module:** 13 — Notifications & Communication (Multi-channel engine: push/FCM, SMS, email, in-app)
**Status:** Design — Approved for implementation reference
**Architecture style:** Modular Monolith (NestJS) · Clean Architecture · DDD · SOLID
**Depends on:** Module 01 (Identity), 02 (Preferences). Consumed by: **every** module (event-driven).
**Traceability:** FR-NOT-01..09, FR-AC-13, BRULE-42, BRULE-43, BRULE-44, NFR-AVAIL, NFR-SCAL, NFR-LOC-02/04, NFR-PRIV, NFR-AUDIT

> Single source of truth for the Notifications & Communication bounded context. No implementation code — contracts, schemas, flows, and reasoning only.

---

## 1. Module Objectives

This is the **cross-cutting communication engine** every other module relies on. It turns **domain events** (order placed, prescription verified, appointment reminder, payment received, delivery en route…) into **multi-channel notifications** (push, SMS, email, in-app), respecting user **preferences**, **localization** (Amharic/English), **quiet hours**, and delivering **reliably** with tracking and retries.

**Design principle — a centralized, event-driven notification service, not scattered send-calls.** Rather than each module calling FCM/SMS directly, modules **emit domain events** (or call a single `INotificationPort`); this module owns **templates, channel selection, preferences, localization, throttling, delivery, retries, and audit**. This removes duplication, centralizes compliance (consent/opt-out, BRULE-43), and makes channels swappable.

**Primary objectives**
- Deliver notifications across **push (FCM), SMS, email, in-app** (FR-NOT-01, NFR-LOC-02).
- Trigger from **domain events** platform-wide (order, prescription, appointment, payment, delivery, etc.) (FR-NOT-02..07).
- Respect **user preferences & channel opt-in/out** per category (FR-NOT-08, FR-AC-13, BRULE-43).
- Support **localized templates** (am/en) with variables (FR-NOT-09, NFR-LOC-02).
- Ensure **reliable delivery**: queue, retry with backoff, dead-letter, and **delivery status tracking** (BRULE-42, NFR-AVAIL).
- Maintain an **in-app notification center** (read/unread, history).
- Enforce **critical vs optional** notification rules (some transactional messages bypass marketing opt-out) (BRULE-44).

---

## 2. Business Requirements

| ID | Business Requirement | Source |
| --- | --- | --- |
| BR-NT-01 | Support push, SMS, email, and in-app channels. | FR-NOT-01 |
| BR-NT-02 | Notifications are triggered by system/domain events. | FR-NOT-02..07 |
| BR-NT-03 | Users control notification preferences per category/channel. | FR-NOT-08, FR-AC-13, BRULE-43 |
| BR-NT-04 | Templates support Amharic and English with variables. | FR-NOT-09, NFR-LOC-02 |
| BR-NT-05 | Delivery is reliable with retries and status tracking. | BRULE-42, NFR-AVAIL |
| BR-NT-06 | An in-app notification center shows history and unread state. | FR-NOT-01 |
| BR-NT-07 | Transactional/critical notifications are always delivered (bypass marketing opt-out). | BRULE-44 |
| BR-NT-08 | Marketing/promotional messages require opt-in and honor opt-out. | BRULE-43 |
| BR-NT-09 | Notification content respects privacy (no sensitive health details in insecure channels). | NFR-PRIV, BRULE-37 |
| BR-NT-10 | Quiet hours / rate limits prevent notification fatigue. | (Vision UX) |

---

## 3. Functional Requirements (Module Features)

### 3.1 Channels & Delivery
- **F-NT-01** Push via **FCM** (Android/iOS/web); device-token management (register/unregister).
- **F-NT-02** **SMS** via a local Ethiopian SMS gateway (+ international for diaspora) (NLOC-02).
- **F-NT-03** **Email** via an email provider (transactional).
- **F-NT-04** **In-app** notifications (persisted, read/unread) + real-time push to open app (WebSocket).
- **F-NT-05** Channel **fallback**: if primary channel fails/unavailable (e.g., no push token), fall back per policy (e.g., SMS).
- **F-NT-06** Delivery **status tracking** per notification/channel (queued→sent→delivered→failed) (BRULE-42).

### 3.2 Templates & Localization
- **F-TM-01** Named, versioned templates per event type + channel + locale (am/en) (FR-NOT-09).
- **F-TM-02** Variable interpolation ({{orderNumber}}, {{doctorName}}) with safe rendering.
- **F-TM-03** Channel-appropriate formatting (SMS length limits, email HTML, push title/body).
- **F-TM-04** Admin management of templates (edit copy without redeploy — NFR-MAINT-03).

### 3.3 Preferences & Compliance
- **F-PR-01** Per-user, per-category, per-channel preferences (FR-NOT-08, FR-AC-13).
- **F-PR-02** Category taxonomy: TRANSACTIONAL (orders, payments, Rx, delivery), REMINDERS (appointments), ACCOUNT (security), MARKETING (promos).
- **F-PR-03** **Critical/transactional bypass**: security + order/health-critical messages ignore marketing opt-out (BRULE-44).
- **F-PR-04** Marketing opt-in/opt-out + unsubscribe honored (BRULE-43).
- **F-PR-05** Quiet hours + per-category rate limits (anti-fatigue).

### 3.4 Notification Center & History
- **F-NC-01** In-app list: unread badge, mark read/all-read, pagination.
- **F-NC-02** Notification history + delivery status (for support/debugging).

### 3.5 Orchestration
- **F-OR-01** Consume domain events from all modules → resolve recipients, template, channels, preferences → enqueue.
- **F-OR-02** Idempotent processing (dedup by event id) — no duplicate sends on retry.
- **F-OR-03** Retry with exponential backoff + dead-letter queue for permanent failures (BRULE-42).
- **F-OR-04** Batch/broadcast (admin announcements, targeted campaigns) (FR-ADM).

---

## 4. Non-Functional Requirements

| Attribute | Requirement | Design Response |
| --- | --- | --- |
| **Reliability** | No lost notifications; retries (BRULE-42, NFR-AVAIL) | Durable queue (BullMQ/Redis) + retry/backoff + DLQ; outbox-consumed events. |
| **Scalability** | High volume, spikes (NFR-SCAL) | Async workers per channel; horizontal scaling; provider rate-limit aware. |
| **Latency** | Timely (reminders/OTP) | Priority queues (critical > marketing); near-real-time in-app via WS. |
| **Localization** | am/en (NFR-LOC-02) | Locale-resolved templates; per-user language from Module 2. |
| **Privacy** | No sensitive health data in insecure channels (BRULE-37) | Content policy: SMS/push carry minimal info + deep link, not clinical details. |
| **Extensibility** | New channels/providers (NFR-INTEROP) | `INotificationChannel` strategy + provider adapters. |
| **Auditability** | Delivery + consent trail (NFR-AUDIT) | Notification log + status history + preference-change audit. |
| **Idempotency** | No duplicate sends | Dedup by event id + notification key. |

---

## 5. Domain Model

### 5.1 Aggregates & Entities
- **Notification** (aggregate root) — one notification instance to a recipient: category, payload, resolved channels, status.
- **NotificationDelivery** (entity) — a per-channel delivery attempt + status + provider ref.
- **NotificationTemplate** (aggregate root) — versioned template per event/channel/locale.
- **NotificationPreference** (entity) — a user's per-category/channel choice (source-of-truth may live in Module 2; mirrored/queried here).
- **DeviceToken** (entity) — a registered push token for a user device.
- **InAppNotification** (projection) — persisted in-app entries with read state.

### 5.2 Value Objects
- `Channel` (PUSH|SMS|EMAIL|IN_APP), `Category` (TRANSACTIONAL|REMINDER|ACCOUNT|MARKETING), `Priority` (CRITICAL|HIGH|NORMAL|LOW), `Locale` (am|en), `DeliveryStatus` (QUEUED|SENT|DELIVERED|FAILED|SUPPRESSED), `TemplateKey`, `RenderedMessage` (title/body per channel), `RecipientRef`.

### 5.3 Invariants
- A notification is sent on a channel **only if** the user's preference allows it **or** it's `CRITICAL/TRANSACTIONAL` (which bypass marketing opt-out, BRULE-44).
- **MARKETING** requires explicit opt-in and honors opt-out/unsubscribe (BRULE-43) — never bypasses.
- Each event→notification is **idempotent** (dedup key) — retries never duplicate a send.
- Every delivery attempt records a **status** (tracking, BRULE-42); permanent failures go to DLQ, not silently dropped.
- **Sensitive health content** is never placed in SMS/push bodies — only a neutral prompt + secure deep link (BRULE-37, NFR-PRIV).
- Templates are **versioned**; a send records which template version rendered it (audit/repro).

**Design rationale — event-driven + priority queues + idempotency.** Notifications are inherently asynchronous, spiky, and must never be lost or duplicated. An event-driven consumer over a **durable queue with priority lanes** (critical OTP/order messages jump ahead of marketing) + **idempotency keys** gives reliability (BRULE-42) and fairness. Centralizing preference/consent evaluation here means every module automatically complies with opt-out rules (BRULE-43/44) without repeating logic.

---

## 6. Delivery Pipeline & Reliability (BRULE-42)

```
Domain event (any module) → Notification consumer
  1. Dedup (event id + notification key) — already processed? drop
  2. Resolve recipient(s) + locale (Module 1/2)
  3. Resolve template (event+channel+locale, versioned)
  4. Evaluate preferences + category rules (critical bypass; marketing opt-in; quiet hours)
     → compute allowed channels (SUPPRESSED if none)
  5. Render message per channel (variable interpolation, content policy)
  6. Enqueue per-channel jobs on priority queue (CRITICAL→LOW)
Channel workers (push/sms/email/in-app):
  7. Send via provider adapter → record NotificationDelivery(SENT/FAILED + provider ref)
  8. Retry with exponential backoff on transient failure; after N → DLQ + mark FAILED
  9. Provider delivery receipts (SMS/push callbacks) → update status DELIVERED
```

- **Priority lanes** — CRITICAL (OTP, payment, Rx verification) processed ahead of MARKETING.
- **Fallback** — no push token or push failed → fall back to SMS/email per policy (F-NT-05).
- **DLQ** — permanently failing jobs preserved for inspection/replay (no silent loss).

**Design rationale.** The pipeline separates **decisioning** (recipient/template/preference/render — fast, in-process) from **delivery** (async per-channel workers with retries). This isolates slow, failure-prone provider I/O from the event-processing path and lets each channel scale/retry independently (NFR-SCAL, NFR-AVAIL).

---

## 7. Database Design (PostgreSQL via Prisma; queue in Redis)

UUID v7 PKs; timestamps. Hot queue state in Redis (BullMQ); Postgres for durable records/templates/prefs/log.

**notifications** — aggregate root (one logical notification).
- `id`, `user_id` (FK), `category`, `priority`, `event_type`, `event_id` (dedup), `template_key`, `template_version`, `locale`, `payload` (jsonb: variables — non-sensitive), `status` (overall), `created_at`.
- Unique (`event_id`,`user_id`,`category`) for idempotency.

**notification_deliveries** — per-channel attempts.
- `id`, `notification_id` (FK), `channel` (PUSH|SMS|EMAIL|IN_APP), `provider` (key), `provider_ref` (nullable), `status` (QUEUED|SENT|DELIVERED|FAILED|SUPPRESSED), `attempts`, `last_error` (nullable), `sent_at`, `delivered_at`, `created_at`.

**notification_templates** — versioned templates.
- `id`, `key` (event type), `channel`, `locale` (am|en), `version`, `title_template` (nullable), `body_template`, `is_active`, `created_by`, `created_at`.
- Unique (`key`,`channel`,`locale`,`version`).

**notification_preferences** — per user/category/channel (may mirror Module 2).
- `id`, `user_id` (FK), `category`, `channel`, `enabled` (bool), `updated_at`. Unique (`user_id`,`category`,`channel`).

**device_tokens** — push tokens.
- `id`, `user_id` (FK), `token`, `platform` (ANDROID|IOS|WEB), `is_active`, `last_seen_at`, `created_at`. Unique (`token`).

**in_app_notifications** — notification center entries.
- `id`, `user_id` (FK), `notification_id` (FK, nullable), `title`, `body`, `deep_link`, `is_read`, `read_at`, `created_at`.
- Index (`user_id`,`is_read`,`created_at`).

**broadcast_campaigns** — admin announcements/campaigns.
- `id`, `title`, `segment` (jsonb: targeting), `template_key`, `channels` (array), `status`, `scheduled_at`, `created_by`, `created_at`.

**Relationships**
- `notifications 1—N notification_deliveries`.
- `notifications 1—1 in_app_notifications` (when in-app channel used).
- `users 1—N device_tokens / notification_preferences / in_app_notifications`.

**Rationale.** Notification decisioning + durable records live in Postgres; the **hot queue** (jobs, retries, backoff, priorities) lives in **Redis/BullMQ** — the right tool for high-throughput ephemeral work. Delivery status per channel enables the tracking BRULE-42 requires. `payload` deliberately stores only non-sensitive variables (privacy, BRULE-37).

---

## 8. API Design

Base paths: `/api/v1/notifications` (user), `/api/v1/notifications/internal` (event ingress — internal), `/api/v1/admin/notifications`. Bearer auth; internal endpoints restricted to service/event bus. Envelope/errors per Module 1 §14.

### 8.1 User — Notification Center & Preferences
- **GET `/notifications`** — in-app center (paginated, unread filter).
- **POST `/notifications/{id}/read`** / **POST `/notifications/read-all`** — mark read.
- **GET `/notifications/unread-count`** — badge count.
- **GET `/notifications/preferences`** — per-category/channel matrix.
- **PATCH `/notifications/preferences`** — update (marketing opt-in/out; can't disable CRITICAL — BRULE-44). Audited.
- **POST `/notifications/devices`** / **DELETE `/notifications/devices/{token}`** — register/unregister push token.
- **WS `/notifications/stream`** — real-time in-app delivery to open app.

### 8.2 Internal — Event Ingress (from modules / event bus)
- **POST `/notifications/internal/dispatch`** — `{ eventType, eventId, userId(s), payload, categoryHint }` → decisioning + enqueue. Idempotent by `eventId`. (Most modules use this via `INotificationPort` / outbox rather than HTTP.)

### 8.3 Provider Webhooks (delivery receipts)
- **POST `/notifications/webhooks/{provider}`** — SMS/push delivery receipts → update `notification_deliveries` status (BRULE-42). Signature-verified.

### 8.4 Admin
- **CRUD `/admin/notifications/templates`** — manage versioned templates (am/en) — `notification:manage`.
- **POST `/admin/notifications/broadcast`** — create/schedule campaign (segmented, marketing rules apply).
- **GET `/admin/notifications/deliveries`** — monitor delivery rates, failures, DLQ.
- **POST `/admin/notifications/deliveries/{id}/replay`** — replay a failed delivery.

**Representative errors:** `TEMPLATE_NOT_FOUND`, `INVALID_TEMPLATE_VARIABLES`, `CANNOT_DISABLE_CRITICAL` (BRULE-44), `MARKETING_OPT_IN_REQUIRED` (BRULE-43), `DEVICE_TOKEN_INVALID`, `PROVIDER_SEND_FAILED` (→ retry/DLQ), `WEBHOOK_SIGNATURE_INVALID`, `RBAC_FORBIDDEN`, `VALIDATION_ERROR`.

---

## 9. NestJS Folder Structure (Clean Architecture)

```
src/modules/notifications/
  domain/
    entities/            # Notification, NotificationDelivery, NotificationTemplate,
    │                    # NotificationPreference, DeviceToken, InAppNotification, BroadcastCampaign
    value-objects/       # Channel, Category, Priority, Locale, DeliveryStatus, TemplateKey, RenderedMessage
    events/              # NotificationQueued, NotificationSent, NotificationDelivered,
    │                    # NotificationFailed, PreferenceUpdated
    enums/               # Channel, Category, Priority, DeliveryStatus, Platform
    repositories/        # INotificationRepository, IDeliveryRepository, ITemplateRepository,
    │                    # IPreferenceRepository, IDeviceTokenRepository, IInAppRepository
    services/            # PreferenceEvaluator (critical bypass/opt-out), TemplateRenderer,
    │                    # ChannelSelector, ContentPolicy (privacy), QuietHoursPolicy
  application/
    commands/            # DispatchNotification, SendChannel, MarkRead, UpdatePreferences,
    │                    # RegisterDevice, CreateTemplate, CreateBroadcast, ReplayDelivery
    queries/             # GetInApp, GetUnreadCount, GetPreferences, GetDeliveryStatus
    ports/               # IPushProviderPort(FCM), ISmsProviderPort, IEmailProviderPort,
    │                    # IRealtimePort(WS in-app), IIdentityPort(1), IProfilePort(2 locale/prefs),
    │                    # IQueuePort, IAuditPort
    dtos/  mappers/
  infrastructure/
    persistence/prisma/  repositories/
    queue/               # BullMqQueueAdapter (priority lanes, retry/backoff, DLQ)
    providers/
      push/              # FcmAdapter (IPushProviderPort)
      sms/               # EthioSmsAdapter + InternationalSmsAdapter (ISmsProviderPort)
      email/             # EmailAdapter (SES/SMTP)
    realtime/            # InAppWsGateway (IRealtimePort)
    workers/             # PushWorker, SmsWorker, EmailWorker, InAppWorker (consume queue)
    webhooks/            # DeliveryReceiptHandler + SignatureVerifier
    scheduling/          # BroadcastScheduler, DlqInspector
    audit/
  interface/
    ws/                  # NotificationStreamGateway (in-app real-time)
    http/
      controllers/       # NotificationCenterController, PreferenceController, DeviceController,
      │                  # InternalDispatchController, WebhookController, AdminNotificationController
      dtos/ guards/ decorators/ filters/ interceptors/
    events/              # global event subscribers: OrderPlaced, RxVerified, AppointmentReminder,
    │                    # PaymentCaptured, DeliveryEnRoute, ... → DispatchNotification
  notifications.module.ts
```

**Rationale.** `PreferenceEvaluator` + `ContentPolicy` centralize compliance (opt-out BRULE-43, critical bypass BRULE-44, health-privacy BRULE-37) so no other module repeats it. Each channel is a `INotificationChannel`/provider adapter (Strategy) — add WhatsApp/Telegram later with no core change. Channel workers consume a durable priority queue via `IQueuePort` (BullMQ), isolating provider I/O.

---

## 10. Sequence Flows

### 10.1 Event → Multi-Channel Dispatch
```
Any module (e.g., Orders) → emit OrderPlaced (outbox) → Notification subscriber
DispatchNotification → dedup(event_id)  [processed? drop]
DispatchNotification → IProfilePort: recipient locale + preferences (Module 2)
DispatchNotification → PreferenceEvaluator: category=TRANSACTIONAL → critical bypass; allowed channels
DispatchNotification → TemplateRenderer: template(OrderPlaced, channel, locale, version) + variables
DispatchNotification → ContentPolicy: strip sensitive; SMS/push = neutral + deep link
DispatchNotification → IQueuePort: enqueue per-channel jobs (priority)
→ Notification(QUEUED) + deliveries(QUEUED)
```

### 10.2 Channel Send + Retry + Receipt (BRULE-42)
```
PushWorker ← queue → IPushProviderPort(FCM).send(token, msg)
  success → NotificationDelivery=SENT (provider_ref)
  transient fail → retry backoff; after N → DLQ + FAILED
  no token → ChannelSelector fallback → SMS
Provider → POST /notifications/webhooks/fcm (receipt) → DeliveryReceiptHandler → status DELIVERED
InApp channel → InAppWorker → persist in_app_notification + InAppWsGateway push (real-time badge)
```

### 10.3 Preference Update (compliance, BRULE-43/44)
```
User → PATCH /notifications/preferences {category: MARKETING, channel: SMS, enabled: false}
UpdatePreferences → MARKETING → allow opt-out (BRULE-43)
User → PATCH {category: TRANSACTIONAL, enabled: false}
UpdatePreferences → CANNOT_DISABLE_CRITICAL (BRULE-44)  [rejected]
UpdatePreferences → persist; IAuditPort: PREFERENCE_CHANGED
```

### 10.4 Admin Broadcast (marketing)
```
Admin → POST /admin/notifications/broadcast {segment, template, channels, scheduleAt}
CreateBroadcast → resolve segment (opted-in users only for MARKETING, BRULE-43)
BroadcastScheduler → at time → fan-out DispatchNotification per user (rate-limited)
```

---

## 11. Error Handling

Reuses Module 1 §14. Delivery failures are **never silent** — they retry then land in DLQ with `PROVIDER_SEND_FAILED` recorded. Compliance guards: `CANNOT_DISABLE_CRITICAL` (BRULE-44), `MARKETING_OPT_IN_REQUIRED` (BRULE-43). `INVALID_TEMPLATE_VARIABLES` caught at render (fail fast, don't send broken messages). Webhook signature failures logged as security events. A missing template falls back to a safe default + alerts admin rather than dropping a critical message.

---

## 12. Logging & Auditing

Reuses hash-chained `audit_logs` for preference changes + template edits + broadcasts. Per-notification **delivery status** (`notification_deliveries`) is the operational trail (BRULE-42). **Must-log:** dispatch decisions (suppressed-by-preference included, for compliance proof), sends/failures/DLQ, delivery receipts, preference opt-in/out changes (consent proof for BRULE-43/44), template version used per send, admin broadcasts (who/segment). **Never log** message bodies containing personal/health content beyond non-sensitive variables (BRULE-37).

---

## 13. Future Scalability & Evolution

- **New channels** — WhatsApp, Telegram, voice/IVR via new provider adapters behind the channel port (Ethiopia has high Telegram usage — likely valuable).
- **Throughput** — channel workers scale horizontally; priority lanes keep OTP/critical fast under marketing load; provider rate-limit backpressure.
- **Smart delivery (future)** — send-time optimization, channel preference learning, fatigue reduction via ML behind `ChannelSelector`.
- **Rich templates** — localized rich push/email with a template editor; A/B testing for campaigns.
- **Provider redundancy** — multiple SMS gateways with failover (Ethiopian delivery reliability).
- **Extraction-ready** — already an event-driven, port-based service; the natural first extraction alongside a message bus (it only needs events + recipient/preference lookups).

---

## Open Questions for Product/Compliance
1. **SMS gateway(s)** — which Ethiopian SMS provider(s) (and international for diaspora)? Redundancy/failover needed?
2. **Telegram channel** — given high local usage, is a Telegram bot channel in scope (possibly higher-value than email)?
3. **Preference source of truth** — do preferences live here or in Module 2 (`notification_preferences`)? (Recommend Module 2 owns, this module reads/caches.)
4. **Quiet hours & rate limits** — default quiet-hours window and per-category caps to prevent fatigue.
5. **Critical bypass scope** — exact list of notification types that qualify as CRITICAL/transactional and bypass opt-out (BRULE-44).
6. **OTP delivery** — is OTP owned here (as a notification type) or by Module 1 auth directly? (affects latency SLOs.)

---

**End of Module 13 design.** Awaiting your approval to proceed. Recommended next module: **Search & Discovery** — the cross-cutting search/matching surface unifying catalog, pharmacy availability, providers, and doctors into fast, geo-aware, typo-tolerant search (FR-MED-01/02/07, FR-HOSP-05/06, FR-DOC-04), consolidating the search read-models designed across Modules 3/4/9/10. Want me to proceed, or adjust Module 13 first?

