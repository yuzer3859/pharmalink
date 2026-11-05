import { ApprovalRequestProps, ApprovalStatus } from './approval-request';

export const APPROVAL_REQUEST_REPOSITORY = Symbol('APPROVAL_REQUEST_REPOSITORY');

export type NewApprovalRequest = Omit<
  ApprovalRequestProps,
  | 'status'
  | 'decisionNote'
  | 'decidedByUserId'
  | 'decidedAt'
  | 'executedAt'
  | 'executionResult'
  | 'executionError'
  | 'createdAt'
  | 'updatedAt'
>;

/** Why an insert did not happen. */
export type ApprovalInsertConflict = 'MAKER_KEY' | 'PENDING_FOR_TARGET';

export interface ApprovalTransition {
  status?: ApprovalStatus;
  decidedByUserId?: string;
  decidedAt?: Date;
  decisionNote?: string | null;
  executedAt?: Date;
  executionResult?: Record<string, unknown>;
  executionError?: { code: string; message: string };
}

export interface ApprovalSearchCriteria {
  status?: ApprovalStatus;
  actionType?: string;
  requestedByUserId?: string;
  /** "Now", for treating a past-expiry PENDING request as EXPIRED in the filter. */
  now: Date;
}

export interface ApprovalPage {
  items: ApprovalRequestProps[];
  total: number;
  page: number;
  size: number;
}

export interface IApprovalRequestRepository {
  /** Inserts, or reports which unique rule refused it. */
  insert(
    request: NewApprovalRequest,
    tx?: unknown,
  ): Promise<{ created: ApprovalRequestProps } | { conflict: ApprovalInsertConflict }>;

  findById(id: string, tx?: unknown): Promise<ApprovalRequestProps | null>;

  findByMakerKey(
    requestedByUserId: string,
    actionType: string,
    makerIdempotencyKey: string,
  ): Promise<ApprovalRequestProps | null>;

  findPendingForTarget(actionType: string, entityId: string): Promise<ApprovalRequestProps | null>;

  /**
   * Applies `change` only while the request is still in `from` (and, with `unexecuted`, has no
   * `executedAt`). Returns the updated request, or `null` when another caller moved it first.
   */
  transition(
    id: string,
    from: ApprovalStatus,
    change: ApprovalTransition,
    tx?: unknown,
    options?: { unexecuted?: boolean },
  ): Promise<ApprovalRequestProps | null>;

  search(criteria: ApprovalSearchCriteria, page: number, size: number): Promise<ApprovalPage>;

  /** PENDING requests whose expiry has passed, oldest first. */
  findDueForExpiry(now: Date, limit: number): Promise<ApprovalRequestProps[]>;
}
