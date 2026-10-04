export const NOTIFICATION_PORT = Symbol('PRESCRIPTION_MATCHING_NOTIFICATION_PORT');

export type NotificationChannel = 'SMS' | 'EMAIL' | 'PUSH';

export interface NotificationRequest {
  channel: NotificationChannel;
  to: string;
  template: string;
  data: Record<string, string | number>;
}

/**
 * Outbound-communication port (module-05 §2.1, BR-RX-05) — own copy per ADR-002, mirroring
 * `modules/identity/application/ports/notification.port.ts` (Module 01's own copy; Modules 03/04
 * never needed one, so there is no "reuse Module 04's copy" precedent to follow here). All
 * outbound comms are meant to ultimately route through Module 13 (Notifications) — already
 * Phase 0 and existing per the roadmap, so this is a real dependency, not deferred. Used for
 * `PrescriptionApproved`/`PrescriptionRejected`/match-failed notifications (§2.1, §4 BR-RX-05).
 */
export interface INotificationPort {
  send(request: NotificationRequest): Promise<void>;
}
