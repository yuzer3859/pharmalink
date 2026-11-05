import type { Approval, ApprovalAction, ApprovalDecision, ApprovalPage, ApprovalStatus } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';
import { toQuery } from './adminFinance.service';

/** Maker-checker requests (Work 82): `GET /admin/approvals`, `POST /admin/approvals/{id}/decide`. */
export const APPROVAL_STATUSES: ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'FAILED', 'EXPIRED'];
export const APPROVAL_PAGE_SIZES = [10, 25, 50] as const;
/** The server's bound for a decision reason. */
export const MAX_APPROVAL_REASON_LENGTH = 500;

export interface ApprovalFilters {
  status?: ApprovalStatus | 'all';
  mine?: boolean;
  page?: number;
  size?: number;
}

const MESSAGES: Record<string, string> = {
  MAKER_CHECKER_SELF_APPROVAL: 'You made this request, so a different administrator must decide it.',
  APPROVAL_EXPIRED: 'This request has expired and can no longer be decided.',
  APPROVAL_ALREADY_DECIDED: 'This request has already been decided.',
};

export function approvalErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (MESSAGES[error.code]) return MESSAGES[error.code];
  if (error.code === 'RESOLUTION_ACTION_FAILED') {
    const cause = (error.details as { cause?: { message?: string } } | undefined)?.cause?.message;
    return cause ? `Approved, but the action could not be carried out: ${cause}` : error.message;
  }
  if (error.status === 403) return 'Your account is not allowed to decide this request.';
  if (error.status === 404) return 'That request no longer exists.';
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

export function createAdminApprovalsService(request: SessionRequest) {
  const get = <T>(path: string) => request<T>(path, { method: 'GET' });
  return {
    list: (f: ApprovalFilters = {}) =>
      get<ApprovalPage>(
        `/admin/approvals${toQuery({ status: f.status, mine: f.mine ? 'true' : undefined, page: f.page, size: f.size })}`,
      ),

    get: (id: string) => get<Approval>(`/admin/approvals/${encodeURIComponent(id)}`),

    actions: () => get<{ items: ApprovalAction[] }>('/admin/approvals/actions'),

    /**
     * Approve (an optional note) or reject (a reason, required). The checker comes from the session;
     * the server refuses the maker and anyone without the action's own permission.
     */
    decide: (id: string, decision: ApprovalDecision, reason?: string) =>
      request<Approval>(`/admin/approvals/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: reason?.trim() ? { decision, reason: reason.trim() } : { decision },
      }),
  };
}

export const adminApprovalsService = createAdminApprovalsService(authService.request);
