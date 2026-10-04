import {
  PaginatedResult,
  VerificationDecisionResult,
} from '../../../identity/application/ports/inbound/identity-admin.port';
import { VerificationReviewView } from '../../application/queries/get-verification.query';
import { VerificationQueueItemView } from '../../application/queries/list-verification-queue.query';
import { VerificationAging } from '../../application/support/verification-aging';

export interface VerificationAgingResponse {
  pendingSince: string | null;
  ageSeconds: number;
}

/**
 * One queue row. An explicit allow-list, like every response in this repository: no document
 * references (the count is enough to triage; the refs are on the detail read), no Fayda
 * identifier under any name, no applicant contact details.
 */
export interface VerificationQueueItemResponse {
  requestId: string;
  userId: string;
  organizationId: string | null;
  type: string;
  status: string;
  documentCount: number;
  submittedAt: string;
  reviewedAt: string | null;
  aging: VerificationAgingResponse;
}

export interface VerificationQueueResponse {
  items: VerificationQueueItemResponse[];
  total: number;
  page: number;
  size: number;
}

export interface VerificationDocumentResponse {
  kind: string;
  /** Module 01's opaque storage reference, as stored. Not a URL; nothing here can fetch it. */
  storageRef: string;
  expiresAt: string | null;
}

export interface VerificationDetailResponse extends VerificationQueueItemResponse {
  documents: VerificationDocumentResponse[];
  hasFaydaId: boolean;
  reviewerId: string | null;
  rejectReason: string | null;
  expiresAt: string | null;
  applicant: { userId: string; primaryRole: string; accountStatus: string } | null;
}

export interface VerificationDecisionResponse {
  requestId: string;
  type: string;
  previousStatus: string;
  status: string;
  subjectUserId: string;
  organizationId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
}

function toAging(aging: VerificationAging): VerificationAgingResponse {
  return {
    pendingSince: aging.pendingSince?.toISOString() ?? null,
    ageSeconds: aging.ageSeconds,
  };
}

export function toVerificationQueueItemResponse(
  item: VerificationQueueItemView,
): VerificationQueueItemResponse {
  return {
    requestId: item.requestId,
    userId: item.userId,
    organizationId: item.organizationId,
    type: item.type,
    status: item.status,
    documentCount: item.documentCount,
    submittedAt: item.submittedAt.toISOString(),
    reviewedAt: item.reviewedAt?.toISOString() ?? null,
    aging: toAging(item.aging),
  };
}

export function toVerificationQueueResponse(
  result: PaginatedResult<VerificationQueueItemView>,
): VerificationQueueResponse {
  return {
    items: result.items.map(toVerificationQueueItemResponse),
    total: result.total,
    page: result.page,
    size: result.size,
  };
}

export function toVerificationDetailResponse(
  view: VerificationReviewView,
): VerificationDetailResponse {
  return {
    ...toVerificationQueueItemResponse(view),
    documents: view.documents.map((d) => ({
      kind: d.kind,
      storageRef: d.storageRef,
      expiresAt: d.expiresAt,
    })),
    hasFaydaId: view.hasFaydaId,
    reviewerId: view.reviewerId,
    rejectReason: view.rejectReason,
    expiresAt: view.expiresAt?.toISOString() ?? null,
    applicant: view.applicant
      ? {
          userId: view.applicant.userId,
          primaryRole: view.applicant.primaryRole,
          accountStatus: view.applicant.accountStatus,
        }
      : null,
  };
}

export function toVerificationDecisionResponse(
  decision: VerificationDecisionResult,
): VerificationDecisionResponse {
  return {
    requestId: decision.requestId,
    type: decision.type,
    previousStatus: decision.previousStatus,
    status: decision.status,
    subjectUserId: decision.subjectUserId,
    organizationId: decision.organizationId,
    decidedAt: decision.reviewedAt?.toISOString() ?? null,
    expiresAt: decision.expiresAt?.toISOString() ?? null,
  };
}
