import type { VerificationDecision, VerificationDetail, VerificationQueuePage, VerificationStatus, VerificationType } from '@/types';
import { ApiError } from './apiClient';
import { authService, type SessionRequest } from './auth.service';

/** Filters of `GET /admin/verifications` (`verification:queue:read`). */
export interface VerificationFilters {
  status?: VerificationStatus | 'all';
  type?: VerificationType | 'all';
  /** 1-based. */
  page?: number;
  size?: number;
}

export const VERIFICATION_STATUSES: VerificationStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];
export const VERIFICATION_TYPES: VerificationType[] = ['PHARMACY_LICENSE', 'FAYDA', 'DRIVER_DOCS', 'DOCTOR_LICENSE'];
export const VERIFICATION_PAGE_SIZES = [10, 25, 50] as const;

/** The server's bounds (Module 01 / Module 16). */
export const MIN_REJECT_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;
export const MAX_LICENSE_NUMBER_LENGTH = 64;

export function verificationQuery(filters: VerificationFilters): string {
  const params = new URLSearchParams();
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.type && filters.type !== 'all') params.set('type', filters.type);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.size) params.set('size', String(filters.size));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export interface ApprovalInput {
  type: VerificationType;
  licenseNumber?: string;
  /** `YYYY-MM-DD` from a date field; sent as the end of that day in UTC. */
  expiresOn?: string;
  reason?: string;
}

/** End of the given calendar day, UTC, as the API's ISO instant. */
export const endOfDayIso = (date: string) => `${date}T23:59:59.000Z`;

/**
 * Why an approval can't be sent yet, or null. A pharmacy licence needs a licence number (1–64
 * characters) and an expiry later than now (Work 67); the server checks the same again.
 */
export function approvalProblem(input: ApprovalInput, now = new Date()): string | null {
  const reason = input.reason?.trim() ?? '';
  if (reason.length > MAX_REASON_LENGTH) return `The note must be at most ${MAX_REASON_LENGTH} characters.`;
  if (input.expiresOn && Number.isNaN(Date.parse(endOfDayIso(input.expiresOn)))) return 'The expiry date is not valid.';
  if (input.expiresOn && Date.parse(endOfDayIso(input.expiresOn)) <= now.getTime()) return 'The expiry must be later than today.';
  if (input.type === 'PHARMACY_LICENSE') {
    const licenseNumber = input.licenseNumber?.trim() ?? '';
    if (!licenseNumber) return 'Enter the licence number from the document.';
    if (licenseNumber.length > MAX_LICENSE_NUMBER_LENGTH) return `The licence number must be at most ${MAX_LICENSE_NUMBER_LENGTH} characters.`;
    if (!input.expiresOn) return 'Enter the licence expiry date from the document.';
  }
  return null;
}

/** The approval body: only the fields that apply, trimmed; never a reviewer (the server knows who). */
export function approvalBody(input: ApprovalInput): Record<string, string> {
  const body: Record<string, string> = {};
  if (input.type === 'PHARMACY_LICENSE' && input.licenseNumber?.trim()) body.licenseNumber = input.licenseNumber.trim();
  if (input.expiresOn) body.expiresAt = endOfDayIso(input.expiresOn);
  if (input.reason?.trim()) body.reason = input.reason.trim();
  return body;
}

export const isValidRejectReason = (value: string) => {
  const v = value.trim();
  return v.length >= MIN_REJECT_REASON_LENGTH && v.length <= MAX_REASON_LENGTH;
};

export function verificationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 403) return 'Your account is not allowed to do this.';
  if (error.status === 404) return 'That verification request no longer exists.';
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (reason) return `${error.message} (${reason.replace(/_/g, ' ').toLowerCase()})`;
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

/** Seconds as a short age: `45m`, `5h`, `3d`. */
export function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.max(0, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function createAdminVerificationsService(request: SessionRequest) {
  const path = (id: string) => `/admin/verifications/${encodeURIComponent(id)}`;
  return {
    list(filters: VerificationFilters = {}): Promise<VerificationQueuePage> {
      return request<VerificationQueuePage>(`/admin/verifications${verificationQuery(filters)}`, { method: 'GET' });
    },

    get(id: string): Promise<VerificationDetail> {
      return request<VerificationDetail>(path(id), { method: 'GET' });
    },

    /** `provider:verify:any`. A pharmacy licence approval activates the organisation, never the pharmacy. */
    approve(id: string, input: ApprovalInput): Promise<VerificationDecision> {
      return request<VerificationDecision>(`${path(id)}/approve`, { method: 'POST', body: approvalBody(input) });
    },

    /** `provider:verify:any`. */
    reject(id: string, reason: string): Promise<VerificationDecision> {
      return request<VerificationDecision>(`${path(id)}/reject`, { method: 'POST', body: { reason: reason.trim() } });
    },
  };
}

export const adminVerificationsService = createAdminVerificationsService(authService.request);
