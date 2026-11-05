import { Inject, Injectable } from '@nestjs/common';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { AdminErrors } from '../../domain/errors';
import {
  ApprovalRequestProps,
  ApprovalStatus,
  canDecide,
  effectiveStatus,
} from '../../domain/maker-checker/approval-request';
import {
  APPROVAL_REQUEST_REPOSITORY,
  IApprovalRequestRepository,
} from '../../domain/maker-checker/approval-request.repository';
import { MakerCheckerActionRegistry } from '../../domain/maker-checker/maker-checker-action';
import { MakerCheckerGate } from './maker-checker-gate.service';

export const DEFAULT_APPROVAL_PAGE_SIZE = 20;
export const MAX_APPROVAL_PAGE_SIZE = 100;

/** Who is reading, from the token: `canDecide` is answered for them. */
export interface ApprovalReader {
  userId: string;
  permissions: readonly string[];
}

/** A request as a reader sees it: the effective status, and whether they may decide it. */
export interface ApprovalView {
  request: ApprovalRequestProps;
  status: ApprovalStatus;
  canDecide: boolean;
  isOwnRequest: boolean;
}

export interface ApprovalViewPage {
  items: ApprovalView[];
  total: number;
  page: number;
  size: number;
}

export interface ListApprovalsInput {
  reader: ApprovalReader;
  status?: ApprovalStatus;
  actionType?: string;
  /** Only the reader's own requests. */
  mine?: boolean;
  page?: number;
  size?: number;
}

export function toApprovalView(
  request: ApprovalRequestProps,
  reader: ApprovalReader,
  now: Date,
): ApprovalView {
  return {
    request,
    status: effectiveStatus(request, now),
    canDecide: canDecide(
      request,
      reader.userId,
      hasPermission(reader.permissions, request.requiredPermission),
      now,
    ),
    isOwnRequest: request.requestedByUserId === reader.userId,
  };
}

@Injectable()
export class ListApprovalsQuery {
  constructor(
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
  ) {}

  async execute(input: ListApprovalsInput): Promise<ApprovalViewPage> {
    const page = input.page && input.page > 0 ? Math.floor(input.page) : 1;
    const size =
      input.size && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_APPROVAL_PAGE_SIZE)
        : DEFAULT_APPROVAL_PAGE_SIZE;
    const now = new Date();
    const result = await this.approvals.search(
      {
        status: input.status,
        actionType: input.actionType,
        requestedByUserId: input.mine ? input.reader.userId : undefined,
        now,
      },
      page,
      size,
    );
    return { ...result, items: result.items.map((item) => toApprovalView(item, input.reader, now)) };
  }
}

@Injectable()
export class GetApprovalQuery {
  constructor(
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
  ) {}

  async execute(id: string, reader: ApprovalReader): Promise<ApprovalView> {
    const request = await this.approvals.findById(id);
    if (!request) {
      throw AdminErrors.approvalNotFound();
    }
    return toApprovalView(request, reader, new Date());
  }
}

export interface ApprovalActionView {
  type: string;
  entityType: string;
  requiredPermission: string;
  /** Listed in `approvals.makerCheckerActions` right now. */
  requiresApproval: boolean;
}

/** The registered actions and which of them currently need a checker. */
@Injectable()
export class ListApprovalActionsQuery {
  constructor(
    private readonly registry: MakerCheckerActionRegistry,
    private readonly gate: MakerCheckerGate,
  ) {}

  execute(): ApprovalActionView[] {
    return this.registry.types().map((type) => {
      const action = this.registry.find(type)!;
      return {
        type,
        entityType: action.entityType,
        requiredPermission: action.requiredPermission,
        requiresApproval: this.gate.requiresApproval(type),
      };
    });
  }
}
