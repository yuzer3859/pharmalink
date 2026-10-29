export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** One plain-text e-mail. `reference` is the notification id, for the transport's idempotency / headers — never content. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly reference: string;
}

/**
 * What the e-mail provider said, already reduced to safe values (module-13 Work 16): an upper-case
 * code, never the provider's response body or an exception message.
 *
 * - `SENT` — accepted for delivery; `messageId` is the provider's id.
 * - `INVALID_RECIPIENT` — the provider says the address cannot receive mail; retrying won't help.
 * - `TRANSIENT` — try again later: unavailable, throttled, network error, timeout.
 * - `REJECTED` — the message itself was refused; retrying the same message won't help.
 * - `NOT_CONFIGURED` — credentials missing or refused; nothing can be sent until fixed.
 */
export type EmailSendResult =
  | { kind: 'SENT'; messageId: string | null }
  | { kind: 'INVALID_RECIPIENT'; code: string }
  | { kind: 'TRANSIENT'; code: string }
  | { kind: 'REJECTED'; code: string }
  | { kind: 'NOT_CONFIGURED' };

/**
 * The external e-mail provider. Production binds `ResendEmailTransport` (Work 17) — Resend is the
 * approved provider; tests bind `InMemoryEmailTransport`.
 */
export interface IEmailTransport {
  /** A short, non-secret name stored on attempts, e.g. the provider's. */
  readonly name: string;
  /** Whether the provider's credentials are present. Says nothing about whether they are valid. */
  isConfigured(): boolean;
  /** Sends `message`; resolves within `timeoutMs`. Must never log the address, subject or text. */
  send(message: EmailMessage, timeoutMs: number): Promise<EmailSendResult>;
}
