-- Module 13 — Notifications, Work 13: durable external-delivery work.
--
-- One row per (notification, external channel) awaiting or past delivery. `delivery_attempts`
-- (Phase-0 init) is unchanged and remains the immutable attempt history; `notifications` is
-- unchanged (the relation below is declared on this table only). No backfill: notifications
-- recorded before this migration get no job and are never swept.

CREATE TYPE "NotificationDeliveryJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'SUPPRESSED', 'EXHAUSTED');

CREATE TABLE "notification_delivery_jobs" (
    "id"             TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel"        "NotificationChannel" NOT NULL,
    "status"         "NotificationDeliveryJobStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount"   INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastErrorCode"  TEXT,
    "completedAt"    TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- One job per notification and channel, enforced by the database: a redelivered event, a re-run
-- handler or two concurrent recordings cannot queue the same delivery twice.
CREATE UNIQUE INDEX "notification_delivery_jobs_notificationId_channel_key"
    ON "notification_delivery_jobs"("notificationId", "channel");

-- The dispatcher's scan: due PENDING rows by `nextAttemptAt`, and PROCESSING rows whose lease ran out.
CREATE INDEX "notification_delivery_jobs_status_nextAttemptAt_idx"
    ON "notification_delivery_jobs"("status", "nextAttemptAt");

ALTER TABLE "notification_delivery_jobs"
    ADD CONSTRAINT "notification_delivery_jobs_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
