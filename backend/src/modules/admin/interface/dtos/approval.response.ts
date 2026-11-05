import {
  ApprovalActionView,
  ApprovalView,
  ApprovalViewPage,
} from '../../application/maker-checker/approval-queries';

export interface ApprovalResponse {
  id: string;
  actionType: string;
  entityType: string;
  entityId: string;
  summary: string;
  reason: string | null;
  /** The effective status: a PENDING request past its expiry reads EXPIRED. */
  status: string;
  /** What will run, shown to the checker who approves it. Never secret (backend/docs/maker-checker.md). */
  payload: Record<string, unknown>;
  requiredPermission: string;
  requestedByUserId: string;
  decidedByUserId: string | null;
  decisionNote: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  executionResult: Record<string, unknown> | null;
  executionError: { code: string; message: string } | null;
  /** The caller may approve or reject it now. */
  canDecide: boolean;
  /** The caller made it (and so may not decide it). */
  isOwnRequest: boolean;
}

export interface ApprovalListResponse {
  items: ApprovalResponse[];
  total: number;
  page: number;
  size: number;
}

export function toApprovalResponse(view: ApprovalView): ApprovalResponse {
  const r = view.request;
  return {
    id: r.id,
    actionType: r.actionType,
    entityType: r.entityType,
    entityId: r.entityId,
    summary: r.summary,
    reason: r.reason,
    status: view.status,
    payload: r.payload,
    requiredPermission: r.requiredPermission,
    requestedByUserId: r.requestedByUserId,
    decidedByUserId: r.decidedByUserId,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
    executionResult: r.executionResult,
    executionError: r.executionError,
    canDecide: view.canDecide,
    isOwnRequest: view.isOwnRequest,
  };
}

export function toApprovalListResponse(page: ApprovalViewPage): ApprovalListResponse {
  return {
    items: page.items.map(toApprovalResponse),
    total: page.total,
    page: page.page,
    size: page.size,
  };
}

export interface ApprovalActionsResponse {
  items: ApprovalActionView[];
}
