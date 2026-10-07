import { Inject, Injectable, Optional } from '@nestjs/common';
import { createSign } from 'crypto';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { IPushTransport, PushMessage, PushSendResult } from '../../application/ports/outbound/push-transport.port';
import { FcmConfig, FcmCredentials } from './fcm.config';

/** Optional override of `fetch` — the seam the transport's own tests use. Never bound in production. */
export const FCM_HTTP_FETCH = Symbol('FCM_HTTP_FETCH');

export const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const fcmSendUrl = (projectId: string) => `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;

/** Refresh the cached access token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_MESSAGE_ID = 128;

type AccessToken = { kind: 'TOKEN'; value: string } | { kind: 'NOT_CONFIGURED' } | { kind: 'TRANSIENT'; code: string };

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/**
 * Firebase Cloud Messaging over the HTTP v1 API (module-13 Work 14), with Node's own `crypto` and
 * `fetch` — no SDK. Following Google's documented server-to-server flow:
 *
 *  1. an RS256-signed JWT (`iss` = service account, `scope` = firebase.messaging,
 *     `aud` = the token endpoint, `exp` ≤ 1 h) is exchanged at `oauth2.googleapis.com/token` for an
 *     access token, cached until a minute before it expires;
 *  2. `POST fcm.googleapis.com/v1/projects/{id}/messages:send` with
 *     `{ message: { token, notification: { title, body }, data: { notificationId } } }`.
 *
 * Every request carries `AbortSignal.timeout`, so `send` resolves within its timeout (twice, if a
 * token exchange is needed) and never rejects. Results are reduced to `PushSendResult` codes per
 * FCM's documented error codes (`google.firebase.fcm.v1.FcmError.errorCode`): `UNREGISTERED` and
 * `SENDER_ID_MISMATCH` → the token is dead; `QUOTA_EXCEEDED`, `UNAVAILABLE`, `INTERNAL`,
 * `THIRD_PARTY_AUTH_ERROR`, network errors and timeouts → transient; `INVALID_ARGUMENT` → rejected;
 * our own credentials or project refused (401/403/404 with no FCM detail, or the token exchange
 * refused) → not configured. Response bodies, exception messages, the key and the access token are never stored
 * or logged.
 */
@Injectable()
export class FcmHttpV1Transport implements IPushTransport {
  private cached: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<AccessToken> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: FcmConfig,
    private readonly logger: AppLogger,
    @Optional() @Inject(FCM_HTTP_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.logger.setContext(FcmHttpV1Transport.name);
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  isConfigured(): boolean {
    return this.config.credentials() !== null;
  }

  async send(deviceToken: string, message: PushMessage, timeoutMs: number): Promise<PushSendResult> {
    const credentials = this.config.credentials();
    if (!credentials) return { kind: 'NOT_CONFIGURED' };
    const access = await this.accessToken(credentials, timeoutMs);
    if (access.kind !== 'TOKEN') return access;

    let res: Response;
    try {
      res = await this.fetchImpl(fcmSendUrl(credentials.projectId), {
        method: 'POST',
        headers: { authorization: `Bearer ${access.value}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: message.title, body: message.body },
            data: { notificationId: message.notificationId },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { kind: 'TRANSIENT', code: isTimeout(e) ? 'FCM_TIMEOUT' : 'FCM_NETWORK_ERROR' };
    }

    const json = await readJson(res, timeoutMs);
    if (res.ok) {
      const name = typeof json?.name === 'string' ? json.name : null;
      // `projects/{project}/messages/{id}` — keep the id only.
      return { kind: 'SENT', messageId: name ? name.slice(name.lastIndexOf('/') + 1).slice(0, MAX_MESSAGE_ID) || null : null };
    }
    if (res.status === 401) this.cached = null;
    return classify(res.status, fcmErrorCode(json));
  }

  private accessToken(credentials: FcmCredentials, timeoutMs: number): Promise<AccessToken> {
    if (this.cached && this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return Promise.resolve({ kind: 'TOKEN', value: this.cached.value });
    }
    // Concurrent sends share one exchange.
    this.inflight ??= this.exchange(credentials, timeoutMs).finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async exchange(credentials: FcmCredentials, timeoutMs: number): Promise<AccessToken> {
    let assertion: string;
    try {
      const iat = Math.floor(Date.now() / 1000);
      const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
        JSON.stringify({ iss: credentials.clientEmail, scope: FCM_SCOPE, aud: FCM_TOKEN_URL, iat, exp: iat + 3600 }),
      )}`;
      assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey).toString('base64url')}`;
    } catch {
      this.logger.warn('FCM private key could not be used to sign; push is not configured');
      return { kind: 'NOT_CONFIGURED' };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(FCM_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { kind: 'TRANSIENT', code: isTimeout(e) ? 'FCM_TIMEOUT' : 'FCM_NETWORK_ERROR' };
    }
    const json = await readJson(res, timeoutMs);
    if (res.ok && typeof json?.access_token === 'string') {
      const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
      this.cached = { value: json.access_token, expiresAt: Date.now() + expiresIn * 1000 };
      return { kind: 'TOKEN', value: json.access_token };
    }
    if (res.status >= 500 || res.status === 429) return { kind: 'TRANSIENT', code: 'FCM_AUTH_UNAVAILABLE' };
    this.logger.warn(`FCM credentials were refused (HTTP ${res.status}); push is not configured`);
    return { kind: 'NOT_CONFIGURED' };
  }
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** The body as JSON, or `null`; bounded by the same timeout as the request, never throws. */
async function readJson(res: Response, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const body = await Promise.race([res.json(), new Promise((_, reject) => setTimeout(reject, timeoutMs).unref())]);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `error.details[].errorCode` of the `google.firebase.fcm.v1.FcmError` detail, if any. */
function fcmErrorCode(json: Record<string, unknown> | null): string | null {
  const details = (json?.error as { details?: unknown } | undefined)?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details) {
    const detail = d as { '@type'?: unknown; errorCode?: unknown };
    if (typeof detail['@type'] === 'string' && detail['@type'].endsWith('google.firebase.fcm.v1.FcmError') && typeof detail.errorCode === 'string') {
      return detail.errorCode;
    }
  }
  return null;
}

export function classify(status: number, fcmCode: string | null): PushSendResult {
  switch (fcmCode) {
    case 'UNREGISTERED':
      return { kind: 'INVALID_TOKEN', code: 'FCM_UNREGISTERED' };
    case 'SENDER_ID_MISMATCH':
      return { kind: 'INVALID_TOKEN', code: 'FCM_SENDER_ID_MISMATCH' };
    case 'INVALID_ARGUMENT':
      return { kind: 'REJECTED', code: 'FCM_INVALID_ARGUMENT' };
    case 'QUOTA_EXCEEDED':
      return { kind: 'TRANSIENT', code: 'FCM_QUOTA_EXCEEDED' };
    case 'UNAVAILABLE':
      return { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' };
    case 'INTERNAL':
      return { kind: 'TRANSIENT', code: 'FCM_INTERNAL' };
    case 'THIRD_PARTY_AUTH_ERROR':
      return { kind: 'TRANSIENT', code: 'FCM_THIRD_PARTY_AUTH_ERROR' };
  }
  // Without an FCM detail, these are about *our* request — credentials refused, or a project that
  // does not exist (a wrong FCM_PROJECT_ID 404s) — never about the device. Tokens are only ever
  // invalidated on FCM's own UNREGISTERED / SENDER_ID_MISMATCH.
  if (status === 401 || status === 403 || status === 404) return { kind: 'NOT_CONFIGURED' };
  if (status === 400) return { kind: 'REJECTED', code: 'FCM_INVALID_ARGUMENT' };
  if (status === 429) return { kind: 'TRANSIENT', code: 'FCM_QUOTA_EXCEEDED' };
  if (status >= 500) return { kind: 'TRANSIENT', code: 'FCM_UNAVAILABLE' };
  return { kind: 'TRANSIENT', code: 'FCM_ERROR' };
}
