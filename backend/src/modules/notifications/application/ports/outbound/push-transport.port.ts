export const PUSH_TRANSPORT = Symbol('PUSH_TRANSPORT');

/** One push message to one device. Rendered text and the notification's id — nothing else. */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Delivered as the push's data payload so the app can open the notification. */
  readonly notificationId: string;
}

/**
 * What the push service said about one device (module-13 Work 14), already reduced to safe values:
 * an upper-case code, never the service's response body or an exception message.
 *
 * - `SENT` — accepted; `messageId` is the service's id.
 * - `INVALID_TOKEN` — the token is permanently unusable (uninstalled, expired, another sender's).
 * - `TRANSIENT` — try again later (unavailable, internal, quota, network, timeout).
 * - `REJECTED` — the request itself was refused; retrying the same request will not help.
 * - `NOT_CONFIGURED` — credentials missing or refused; nothing can be sent until fixed.
 */
export type PushSendResult =
  | { kind: 'SENT'; messageId: string | null }
  | { kind: 'INVALID_TOKEN'; code: string }
  | { kind: 'TRANSIENT'; code: string }
  | { kind: 'REJECTED'; code: string }
  | { kind: 'NOT_CONFIGURED' };

/** The external push service (FCM in production). Implementations hold their own credentials. */
export interface IPushTransport {
  /** Whether credentials are present. Says nothing about whether they are valid. */
  isConfigured(): boolean;
  /** Sends one message to one device; resolves within `timeoutMs`, never rejects. */
  send(deviceToken: string, message: PushMessage, timeoutMs: number): Promise<PushSendResult>;
}
