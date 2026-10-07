/**
 * Domain enums for the Notifications bounded context (module-13). Framework-free and mirror the
 * string values of the Prisma enums in `backend/prisma/schema/13-notifications.prisma`
 * (`NotificationChannel`, `MessageCategory`, `DeliveryStatus`), so the repository adapter maps
 * 1:1 without a translation table — the same discipline as every other module's `domain/enums.ts`.
 */

export enum NotificationChannel {
  PUSH = 'PUSH',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
  IN_APP = 'IN_APP',
}

export enum NotificationCategory {
  TRANSACTIONAL = 'TRANSACTIONAL',
  REMINDER = 'REMINDER',
  MARKETING = 'MARKETING',
  SYSTEM = 'SYSTEM',
  SECURITY = 'SECURITY',
}

/**
 * Mirrors Prisma's `DeliveryStatus`. An in-app notification uses two of these values: `SENT`
 * when it lands in the recipient's inbox, `READ` once they have read it. The rest belong to the
 * outbound channels a later work adds.
 */
export enum NotificationStatus {
  QUEUED = 'QUEUED',
  SENDING = 'SENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  BOUNCED = 'BOUNCED',
  SUPPRESSED = 'SUPPRESSED',
  READ = 'READ',
}

/** The languages a notification is rendered in — Module 01's `PreferredLanguage` values. */
export enum NotificationLanguage {
  am = 'am',
  en = 'en',
}

/**
 * The language used when the recipient's preference is unavailable. `en` is the repository's
 * existing default: `users.preferredLanguage` and `customer_profiles.preferredLanguage` are both
 * `@default(en)`.
 */
export const DEFAULT_NOTIFICATION_LANGUAGE = NotificationLanguage.en;

/**
 * Mirrors Prisma's `DigestFrequency`, the cadence column of `channel_preferences`. Stored and
 * served as a preference only: no channel batches anything yet (see `domain/preferences.ts`).
 */
export enum DigestFrequency {
  IMMEDIATE = 'IMMEDIATE',
  HOURLY = 'HOURLY',
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
}

/**
 * Mirrors Prisma's `NotificationDeliveryJobStatus` (Work 13): the current state of one
 * notification's delivery on one external channel. `PENDING` covers both "never tried" and "waiting
 * to retry" (`attemptCount` tells them apart); the last three are terminal.
 */
export enum DeliveryJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  SUPPRESSED = 'SUPPRESSED',
  EXHAUSTED = 'EXHAUSTED',
}
