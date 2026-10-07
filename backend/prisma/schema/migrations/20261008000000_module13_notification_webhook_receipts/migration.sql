-- Module 13 — Notifications, Work 18: provider webhook receipts.
--
-- One row per provider webhook delivery already applied (Resend's `svix-id`), keyed so a
-- redelivered or concurrent duplicate cannot be applied twice. No payload, address, signature or
-- secret is stored. `suppression_list` (Phase-0 init) and `delivery_attempts` are reused as they are.

CREATE TABLE "notification_webhook_receipts" (
    "id"         TEXT NOT NULL,
    "provider"   TEXT NOT NULL,
    "eventId"    TEXT NOT NULL,
    "eventType"  TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_webhook_receipts_provider_eventId_key"
    ON "notification_webhook_receipts"("provider", "eventId");
