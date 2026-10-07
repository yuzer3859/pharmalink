import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { EmailMessage, EmailSendResult, IEmailTransport } from '../../application/ports/outbound/email-transport.port';
import { ResendConfig } from './resend.config';

/** Optional override of `fetch` — the seam this transport's own tests use. Never bound in production. */
export const RESEND_HTTP_FETCH = Symbol('RESEND_HTTP_FETCH');

export const RESEND_SEND_URL = 'https://api.resend.com/emails';
const MAX_MESSAGE_ID = 128;

/** Resend's idempotency key for one notification's e-mail — stable across every retry of the job. */
export const resendIdempotencyKey = (reference: string) => `notification-email/${reference}`.slice(0, 256);

/**
 * Resend over its REST API (module-13 Work 17), with Node's `fetch` — no SDK.
 *
 *     POST https://api.resend.com/emails
 *     Authorization: Bearer <RESEND_API_KEY>
 *     Idempotency-Key: notification-email/<notificationId>
 *     { from, to: [address], subject, text }            → 200 { id }
 *
 * Plain text only; nothing else is sent — no HTML, headers, tags or ids in the body. The
 * idempotency key (Resend caches only successful responses for 24 h) means a retry after a
 * timeout that Resend had in fact accepted returns the original send instead of mailing twice; the
 * delivery job stays the authority for the work itself.
 *
 * Every request carries `AbortSignal.timeout`, so `send` resolves within its timeout and never
 * rejects. Results are reduced by HTTP status and Resend's documented error `name`
 * (see `classifyResendError`); the response body, the API key and the address are never stored or
 * logged.
 */
@Injectable()
export class ResendEmailTransport implements IEmailTransport {
  readonly name = 'resend';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: ResendConfig,
    private readonly logger: AppLogger,
    @Optional() @Inject(RESEND_HTTP_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.logger.setContext(ResendEmailTransport.name);
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  isConfigured(): boolean {
    return this.config.credentials() !== null;
  }

  async send(message: EmailMessage, timeoutMs: number): Promise<EmailSendResult> {
    const credentials = this.config.credentials();
    if (!credentials) return { kind: 'NOT_CONFIGURED' };

    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_SEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': resendIdempotencyKey(message.reference),
        },
        body: JSON.stringify({ from: credentials.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: unknown })?.name;
      return { kind: 'TRANSIENT', code: name === 'TimeoutError' || name === 'AbortError' ? 'EMAIL_TIMEOUT' : 'EMAIL_NETWORK_ERROR' };
    }

    const json = await readJson(res, timeoutMs);
    if (res.ok) {
      const id = typeof json?.id === 'string' && json.id.length > 0 ? json.id.slice(0, MAX_MESSAGE_ID) : null;
      // A 2xx without an id is not a result we can trust; retrying is safe under the idempotency key.
      return id ? { kind: 'SENT', messageId: id } : { kind: 'TRANSIENT', code: 'EMAIL_INVALID_RESULT' };
    }
    const result = classifyResendError(res.status, typeof json?.name === 'string' ? json.name : null);
    if (result.kind === 'NOT_CONFIGURED') {
      this.logger.warn(`Resend refused the request as a configuration problem (HTTP ${res.status}); e-mail is paused`);
    }
    return result;
  }
}

/** The body as JSON, or `null`; bounded by the request timeout, never throws. */
async function readJson(res: Response, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const body = await Promise.race([res.json(), new Promise((_, reject) => setTimeout(reject, timeoutMs).unref())]);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Resend's documented errors (api-reference/errors), reduced to the four outcomes the provider
 * understands. Anything about *our* account, key, sender or quota pauses the channel
 * (`NOT_CONFIGURED`: the job waits, no attempt, no retry consumed) rather than burning every job's
 * five retries on a global problem:
 *
 *     401 missing_api_key, 403 invalid_permission / restricted_api_key / suspended_api_key,
 *     403 validation_error (sender domain not verified, test-mode recipient restriction),
 *     429 daily_quota_exceeded / monthly_quota_exceeded, 404 / 405 (wrong endpoint)  → NOT_CONFIGURED
 *     429 rate_limit_exceeded                                    → TRANSIENT EMAIL_RATE_LIMITED
 *     409 concurrent_idempotent_requests / resource_locked       → TRANSIENT EMAIL_CONCURRENT_REQUEST
 *     5xx (application_error, service_unavailable, …)            → TRANSIENT EMAIL_UNAVAILABLE
 *     400 / 422 (validation_error, missing_required_field, …),
 *     409 invalid_idempotent_request                             → REJECTED EMAIL_REJECTED
 *
 * Resend reports a bad recipient as a 4xx validation error without a distinct name, so an invalid
 * address and an invalid message share `EMAIL_REJECTED` — both are not retryable.
 */
export function classifyResendError(status: number, name: string | null): EmailSendResult {
  if (status === 401 || status === 403 || status === 404 || status === 405) return { kind: 'NOT_CONFIGURED' };
  if (status === 429) {
    if (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded') return { kind: 'NOT_CONFIGURED' };
    return { kind: 'TRANSIENT', code: 'EMAIL_RATE_LIMITED' };
  }
  if (status === 409) {
    if (name === 'invalid_idempotent_request') return { kind: 'REJECTED', code: 'EMAIL_REJECTED' };
    return { kind: 'TRANSIENT', code: 'EMAIL_CONCURRENT_REQUEST' };
  }
  if (status >= 500) return { kind: 'TRANSIENT', code: 'EMAIL_UNAVAILABLE' };
  if (status === 400 || status === 422) return { kind: 'REJECTED', code: 'EMAIL_REJECTED' };
  return { kind: 'TRANSIENT', code: 'EMAIL_ERROR' };
}
