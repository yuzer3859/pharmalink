import { ApprovalEntityType, ApprovalStatus } from '@prisma/client';

export { ApprovalEntityType, ApprovalStatus };

/**
 * A maker-checker request as stored (Work 82, backend/docs/maker-checker.md).
 *
 * Plain data rather than a class with behaviour: the transitions are guarded by conditional
 * updates in the repository (`WHERE status = from`), which is the only place a race between two
 * checkers can be decided, so a domain object holding a copy of the status would add nothing but a
 * second, staler opinion about it.
 */
export interface ApprovalRequestProps {
  id: string;
  actionType: string;
  entityType: ApprovalEntityType;
  entityId: string;
  requiredPermission: string;
  requestedByUserId: string;
  makerIdempotencyKey: string;
  summary: string;
  reason: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  executedAt: Date | null;
  executionResult: Record<string, unknown> | null;
  executionError: ApprovalExecutionError | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the owning module said when it refused to run an approved action. */
export interface ApprovalExecutionError {
  code: string;
  message: string;
}

export enum ApprovalDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export const MAX_APPROVAL_REASON_LENGTH = 500;
export const MAX_APPROVAL_SUMMARY_LENGTH = 300;

/** The idempotency key every execution of this request uses, first attempt or resumed. */
export function executionIdempotencyKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

/**
 * The status a reader should see. A `PENDING` request past its expiry is `EXPIRED` even before the
 * sweeper has written that, so the portal never offers a decision the server would refuse.
 */
export function effectiveStatus(request: ApprovalRequestProps, now: Date): ApprovalStatus {
  if (request.status === ApprovalStatus.PENDING && request.expiresAt.getTime() <= now.getTime()) {
    return ApprovalStatus.EXPIRED;
  }
  return request.status;
}

/**
 * Whether `checkerUserId` may decide the request now: it is still open, the checker is not the
 * maker, and they hold the action's own permission. The command enforces each rule separately (each
 * has its own error); this is the read side's single answer for "show the buttons".
 */
export function canDecide(
  request: ApprovalRequestProps,
  checkerUserId: string,
  checkerHoldsPermission: boolean,
  now: Date,
): boolean {
  return (
    effectiveStatus(request, now) === ApprovalStatus.PENDING &&
    request.requestedByUserId !== checkerUserId &&
    checkerHoldsPermission
  );
}
