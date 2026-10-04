import { API_BASE_URL } from '@/config/env';

// Simulated network client. Swap the internals for a real HTTP client (axios/fetch)
// without touching the service or hook layers.

const LATENCY_MS = 350;

export const simulate = <T>(data: T, latency = LATENCY_MS): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredCloneSafe(data)), latency));

// structuredClone is available in modern runtimes; guard for safety.
function structuredCloneSafe<T>(data: T): T {
  if (typeof structuredClone === 'function') return structuredClone(data);
  return JSON.parse(JSON.stringify(data)) as T;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
  meta?: { requestId?: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  accessToken?: string | null;
  refresh?: () => Promise<string | null>;
  onSessionExpired?: () => void;
  retryAuth?: boolean;
}

const REFRESHABLE_AUTH_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'AUTH_TOKEN_INVALID']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return isRecord(value) && typeof value.success === 'boolean' && ('data' in value || 'error' in value);
}

function isRefreshableAuthError(error: ApiError): boolean {
  return error.status === 401 && REFRESHABLE_AUTH_CODES.has(error.code);
}

export class ApiClient {
  constructor(
    private readonly baseUrl = API_BASE_URL,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const {
      accessToken,
      refresh,
      onSessionExpired,
      retryAuth = true,
      body,
      ...requestInit
    } = options;

    let response: Response;
    let payload: unknown;
    try {
      response = await this.send(path, requestInit, body, accessToken);
      payload = await this.readPayload(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the authentication service.', error);
    }

    if (!response.ok) {
      const error = this.toApiError(response, payload);
      if (retryAuth && accessToken && refresh && isRefreshableAuthError(error)) {
        let refreshedAccessToken: string | null;
        try {
          refreshedAccessToken = await refresh();
        } catch (refreshError) {
          if (refreshError instanceof ApiError && refreshError.status === 401) {
            onSessionExpired?.();
          }
          throw refreshError;
        }

        if (!refreshedAccessToken) {
          onSessionExpired?.();
          throw error;
        }

        try {
          response = await this.send(path, requestInit, body, refreshedAccessToken);
          payload = await this.readPayload(response);
        } catch (retryError) {
          if (retryError instanceof ApiError) throw retryError;
          throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the authentication service.', retryError);
        }

        if (!response.ok) {
          const retryFailure = this.toApiError(response, payload);
          if (retryFailure.status === 401) onSessionExpired?.();
          throw retryFailure;
        }
      } else {
        throw error;
      }
    }

    return this.unwrap<T>(payload, response);
  }

  get<T>(path: string, options: Omit<ApiRequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(
    path: string,
    body?: unknown,
    options: Omit<ApiRequestOptions, 'method' | 'body'> = {},
  ): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  private async send(
    path: string,
    init: Omit<RequestInit, 'body'>,
    body: unknown,
    accessToken?: string | null,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

    return this.fetcher(this.toUrl(path), {
      ...init,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private toUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private async readPayload(response: Response): Promise<unknown> {
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private toApiError(response: Response, payload: unknown): ApiError {
    const envelope = isEnvelope(payload) ? payload : undefined;
    const error = envelope?.error;
    const requestId =
      envelope && isRecord(envelope.meta) && typeof envelope.meta.requestId === 'string'
        ? envelope.meta.requestId
        : response.headers.get('x-request-id') ?? undefined;

    return new ApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
      requestId,
    );
  }

  private unwrap<T>(payload: unknown, response: Response): T {
    if (isEnvelope(payload)) {
      if (payload.success) return payload.data as T;
      throw this.toApiError(response, payload);
    }
    return payload as T;
  }
}

export const apiClient = new ApiClient();

export const nextId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
