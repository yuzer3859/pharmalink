import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { approvalDecidedEvent } from '../../domain/events';
import { ApprovalRequestProps, ApprovalStatus } from '../../domain/maker-checker/approval-request';
import {
  APPROVAL_REQUEST_REPOSITORY,
  IApprovalRequestRepository,
} from '../../domain/maker-checker/approval-request.repository';
import { ADMIN_UNIT_OF_WORK, IAdminUnitOfWork } from '../ports/unit-of-work.port';

/** How many due requests one sweep expires; the rest wait for the next sweep. */
export const APPROVAL_EXPIRY_BATCH = 100;

/**
 * Moves PENDING requests past their expiry to EXPIRED, with an audit entry and an event (Work 82).
 * Used by the sweeper and by `DecideApprovalCommand` when a checker reaches a request first.
 */
@Injectable()
export class ExpireApprovalService {
  constructor(
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
    @Inject(ADMIN_UNIT_OF_WORK) private readonly uow: IAdminUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Expires one request. `false` when it was no longer PENDING (decided or expired already). */
  expire(request: ApprovalRequestProps): Promise<boolean> {
    return this.uow.run(async (tx) => {
      const expired = await this.approvals.transition(
        request.id,
        ApprovalStatus.PENDING,
        { status: ApprovalStatus.EXPIRED },
        tx,
      );
      if (!expired) {
        return false;
      }
      await this.audit.record(
        {
          // No actor: time decided this, not a person.
          actorUserId: null,
          action: 'APPROVAL_EXPIRED',
          resourceType: 'ApprovalRequest',
          resourceId: request.id,
          context: {
            actionType: request.actionType,
            entityId: request.entityId,
            requestedBy: request.requestedByUserId,
            expiresAt: request.expiresAt.toISOString(),
          },
        },
        tx,
      );
      await this.outbox.write(
        approvalDecidedEvent({
          approvalId: request.id,
          actionType: request.actionType,
          entityId: request.entityId,
          status: ApprovalStatus.EXPIRED,
          requestedBy: request.requestedByUserId,
          decidedBy: null,
        }),
        tx as OutboxCapableClient,
      );
      return true;
    });
  }

  /** Expires every request due at `now`, up to one batch. Returns how many it expired. */
  async expireDue(now: Date = new Date()): Promise<number> {
    const due = await this.approvals.findDueForExpiry(now, APPROVAL_EXPIRY_BATCH);
    let count = 0;
    for (const request of due) {
      if (await this.expire(request)) {
        count += 1;
      }
    }
    return count;
  }
}
