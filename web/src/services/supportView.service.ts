import type { GatedOutcome } from '@/types';
import { apiClient, type ApiClient } from './apiClient';
import { authService, type SessionRequest } from './auth.service';
import { newIdempotencyKey } from './settlementPayout.service';

export type ImpersonationStatus = 'AUTHORIZED' | 'ACTIVE' | 'ENDED' | 'EXPIRED';

export interface ImpersonationSession {
  id: string;
  targetUserId: string;
  requestedByUserId: string;
  approvedByUserId: string;
  reason: string;
  status: ImpersonationStatus;
  redeemBy: string;
  startedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
}

export interface SupportViewToken {
  sessionId: string;
  accessToken: string;
  expiresAt: number;
  targetUserId: string;
}

/** What the read-only view shows: the account as its holder sees it. */
export interface SupportViewSnapshot {
  me: Record<string, unknown>;
  orders: { items: Array<Record<string, unknown>>; total: number } | null;
}

/**
 * Support "view as" (Work 85). The session token is used only here, for GET requests, and kept in
 * component memory — never in storage, never sent anywhere but the API. The server refuses any write
 * made with it.
 */
export function createSupportViewService(request: SessionRequest, client: Pick<ApiClient, 'request'>, key: () => string = newIdempotencyKey) {
  const enc = encodeURIComponent;
  return {
    request: (userId: string, reason: string) =>
      request<GatedOutcome>(`/admin/accounts/${enc(userId)}/impersonate`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key() },
        body: { reason: reason.trim() },
      }),
    sessions: (targetUserId: string) =>
      request<{ items: ImpersonationSession[]; total: number }>(
        `/admin/impersonation-sessions?targetUserId=${enc(targetUserId)}`,
        { method: 'GET' },
      ),
    start: (sessionId: string) =>
      request<SupportViewToken>(`/admin/impersonation-sessions/${enc(sessionId)}/start`, { method: 'POST', body: {} }),
    end: (sessionId: string) =>
      request<ImpersonationSession>(`/admin/impersonation-sessions/${enc(sessionId)}/end`, { method: 'POST', body: {} }),
    /** Reads with the session token itself (no refresh, no retry): the account as its holder sees it. */
    snapshot: async (token: string): Promise<SupportViewSnapshot> => {
      const read = <T>(path: string) => client.request<T>(path, { method: 'GET', accessToken: token, retryAuth: false });
      const me = await read<Record<string, unknown>>('/users/me');
      const orders = await read<{ items: Array<Record<string, unknown>>; total: number }>('/orders?page=1&size=5').catch(() => null);
      return { me, orders };
    },
  };
}

export const supportViewService = createSupportViewService(authService.request, apiClient);
