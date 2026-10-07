export const SMS_TRANSPORT = Symbol('SMS_TRANSPORT');

/**
 * What the SMS gateway said, already reduced to safe values (module-13 Work 15): an upper-case
 * code, never the gateway's response body or an exception message.
 *
 * - `SENT` — accepted; `messageId` is the gateway's id.
 * - `INVALID_RECIPIENT` — the gateway says the destination cannot receive SMS; retrying won't help.
 * - `TRANSIENT` — try again later: unavailable, rate-limited, network error, timeout.
 * - `REJECTED` — the request itself was refused (e.g. content); retrying the same request won't help.
 * - `NOT_CONFIGURED` — credentials missing or refused; nothing can be sent until fixed.
 */
export type SmsSendResult =
  | { kind: 'SENT'; messageId: string | null }
  | { kind: 'INVALID_RECIPIENT'; code: string }
  | { kind: 'TRANSIENT'; code: string }
  | { kind: 'REJECTED'; code: string }
  | { kind: 'NOT_CONFIGURED' };

/**
 * The external SMS gateway. **No gateway has been chosen** (architecture/module-13-notifications.md,
 * open question 1), so production binds `UnconfiguredSmsTransport`; a real adapter implements this
 * port — and defines its own `SMS_GATEWAY_*` configuration — once one is approved.
 */
export interface ISmsTransport {
  /** A short, non-secret name stored on attempts, e.g. the gateway's. */
  readonly name: string;
  /** Whether the gateway's credentials are present. Says nothing about whether they are valid. */
  isConfigured(): boolean;
  /** Sends `text` to an E.164 `to`; resolves within `timeoutMs`. Must never log `to` or `text`. */
  send(to: string, text: string, timeoutMs: number): Promise<SmsSendResult>;
}
