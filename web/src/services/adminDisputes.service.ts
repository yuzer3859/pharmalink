import { authService, type SessionRequest } from './auth.service';
import { toQuery } from './adminFinance.service';
import { newIdempotencyKey } from './settlementPayout.service';

export type DisputeStatus = 'OPEN' | 'INVESTIGATING' | 'ESCALATED' | 'RESOLUTION_PENDING' | 'RESOLVED' | 'CLOSED';
export type DisputeType = 'ORDER' | 'DELIVERY' | 'PAYMENT' | 'CONTENT';
export type DisputePriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export const DISPUTE_CASE_STATUSES: DisputeStatus[] = ['OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLUTION_PENDING', 'RESOLVED', 'CLOSED'];
export const DISPUTE_PRIORITIES: DisputePriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

/** The moves the server allows by hand (Work 86); resolving has its own form. */
export const NEXT_STATUSES: Partial<Record<DisputeStatus, DisputeStatus[]>> = {
  OPEN: ['INVESTIGATING', 'ESCALATED'],
  INVESTIGATING: ['ESCALATED'],
  ESCALATED: ['INVESTIGATING'],
  RESOLVED: ['CLOSED'],
};

export const RESOLVABLE: DisputeStatus[] = ['OPEN', 'INVESTIGATING', 'ESCALATED', 'RESOLUTION_PENDING'];

export interface DisputeCase {
  id: string;
  caseNumber: string;
  type: DisputeType;
  orderId: string;
  subject: string;
  description: string;
  status: DisputeStatus;
  priority: DisputePriority;
  openedAt: string;
  slaDueAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  overdue: boolean;
  resolution: Record<string, unknown> | null;
  complainantUserId: string;
  openedByUserId: string;
  assignedAdminId: string | null;
  pendingApprovalId: string | null;
}

export interface DisputeMessage {
  id: string;
  senderRole: 'ADMIN' | 'CUSTOMER';
  senderUserId: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

export interface DisputeFilters {
  status?: DisputeStatus | 'all';
  overdue?: boolean;
  mine?: boolean;
  page?: number;
  size?: number;
}

/** The admin dispute desk (Work 86, `dispute:manage:any`). */
export function createAdminDisputesService(request: SessionRequest, key: () => string = newIdempotencyKey) {
  const enc = encodeURIComponent;
  return {
    list: (f: DisputeFilters = {}) =>
      request<{ items: DisputeCase[]; total: number; page: number; size: number }>(
        `/admin/disputes${toQuery({ status: f.status, overdue: f.overdue ? 'true' : undefined, mine: f.mine ? 'true' : undefined, page: f.page, size: f.size })}`,
        { method: 'GET' },
      ),
    get: (id: string) => request<DisputeCase & { messages: DisputeMessage[] }>(`/admin/disputes/${enc(id)}`, { method: 'GET' }),
    update: (id: string, change: { status?: DisputeStatus; priority?: DisputePriority; assignToMe?: boolean; reason?: string }) =>
      request<DisputeCase>(`/admin/disputes/${enc(id)}`, { method: 'PATCH', body: change }),
    message: (id: string, body: string, internal: boolean) =>
      request<DisputeMessage>(`/admin/disputes/${enc(id)}/messages`, { method: 'POST', body: { body: body.trim(), internal } }),
    resolve: (id: string, input: { action: 'NO_ACTION' | 'REFUND'; notes: string; amount?: number }) =>
      request<DisputeCase>(`/admin/disputes/${enc(id)}/resolve`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key() },
        body: { action: input.action, notes: input.notes.trim(), ...(input.action === 'REFUND' && input.amount ? { amount: input.amount } : {}) },
      }),
  };
}

export const adminDisputesService = createAdminDisputesService(authService.request);
