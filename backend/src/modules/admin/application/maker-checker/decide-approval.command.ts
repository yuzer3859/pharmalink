import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { AdminErrors } from '../../domain/errors';
import { approvalDecidedEvent } from '../../domain/events';
import {
  ApprovalDecision,
  ApprovalRequestProps,
  ApprovalStatus,
  executionIdempotencyKey,
  MAX_APPROVAL_REASON_LENGTH,
} from '../../domain/maker-checker/approval-request';
import {
  APPROVAL_REQUEST_REPOSITORY,
  IApprovalRequestRepository,
} from '../../domain/maker-checker/approval-request.repository';
import { MakerCheckerActionRegistry } from '../../domain/maker-checker/maker-checker-action';
import { ADMIN_UNIT_OF_WORK, IAdminUnitOfWork } from '../ports/unit-of-work.port';
import { ExpireApprovalService } from './expire-approval.service';

export interface DecideApprovalInput {
  approvalId: string;
  /** From the verified token. */
  checkerUserId: string;
  checkerPermissions: readonly string[];
  decision: ApprovalDecision;
  /** Required to reject; an optional note on approval. */
  reason?: string | null;
  ip?: string | null;
}

/**
 * `DecideApproval` — `POST /admin/approvals/{id}/decide` (module-16 §11.2, Work 82).
 *
 * The order is deliberate, and it is what makes execution idempotent:
 *
 * 1. **Refuse** what may never be decided: the maker deciding their own request, a checker without
 *    the action's permission, a rejection without a reason, an expired request.
 * 2. **Commit the decision** (`PENDING → APPROVED|REJECTED`) with its audit entry and event, by a
 *    conditional update, so two checkers cannot both decide.
 * 3. **Execute** through the registered action, outside that transaction (the owning module runs
 *    its own), always with the key `approval:<id>`.
 * 4. **Record the outcome**: `executedAt` and the result, or `FAILED` when the module refused.
 *
 * A crash between 2 and 4 leaves the request `APPROVED` with no `executedAt`; approving it again
 * resumes at step 3 with the same key, and the owning module's idempotency makes that safe.
 * Repeating a decision that already happened returns its stored outcome.
 */
@Injectable()
export class DecideApprovalCommand {
  constructor(
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
    @Inject(ADMIN_UNIT_OF_WORK) private readonly uow: IAdminUnitOfWork,
    private readonly registry: MakerCheckerActionRegistry,
    private readonly expiry: ExpireApprovalService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: DecideApprovalInput): Promise<ApprovalRequestProps> {
    const checkerUserId = (input.checkerUserId ?? '').trim();
    if (!checkerUserId) {
      throw AdminErrors.validation('checkerUserId is required.', { field: 'checkerUserId' });
    }
    if (input.decision !== ApprovalDecision.APPROVE && input.decision !== ApprovalDecision.REJECT) {
      throw AdminErrors.validation('decision must be APPROVE or REJECT.', { field: 'decision' });
    }
    const reason = (input.reason ?? '').trim() || null;
    if (reason && reason.length > MAX_APPROVAL_REASON_LENGTH) {
      throw AdminErrors.validation(`reason must be at most ${MAX_APPROVAL_REASON_LENGTH} characters.`, {
        field: 'reason',
      });
    }
    if (input.decision === ApprovalDecision.REJECT && !reason) {
      throw AdminErrors.validation('A reason is required to reject a request.', { field: 'reason' });
    }

    const request = await this.approvals.findById(input.approvalId);
    if (!request) {
      throw AdminErrors.approvalNotFound();
    }
    if (request.requestedByUserId === checkerUserId) {
      throw AdminErrors.approvalSelfDecision();
    }
    if (!hasPermission(input.checkerPermissions, request.requiredPermission)) {
      throw AdminErrors.approvalPermissionMissing(request.requiredPermission);
    }

    return this.decide(request, { ...input, checkerUserId, reason }, true);
  }

  private async decide(
    request: ApprovalRequestProps,
    input: DecideApprovalInput & { checkerUserId: string; reason: string | null },
    mayRetry: boolean,
  ): Promise<ApprovalRequestProps> {
    const approving = input.decision === ApprovalDecision.APPROVE;

    switch (request.status) {
      case ApprovalStatus.PENDING: {
        if (request.expiresAt.getTime() <= Date.now()) {
          await this.expiry.expire(request);
          throw AdminErrors.approvalExpired(request.id);
        }
        const decided = await this.commitDecision(request, input);
        if (!decided) {
          // Another checker (or the sweeper) moved it first: answer from what it is now.
          const current = await this.approvals.findById(request.id);
          if (!current || !mayRetry) {
            throw AdminErrors.approvalAlreadyDecided(request.id, current?.status ?? request.status);
          }
          return this.decide(current, input, false);
        }
        return approving ? this.run(decided, input) : decided;
      }
      case ApprovalStatus.APPROVED:
        if (!approving) {
          throw AdminErrors.approvalAlreadyDecided(request.id, request.status);
        }
        // Executed: the stored outcome. Not executed: an interrupted run, resumed with the same key.
        return request.executedAt ? request : this.run(request, input);
      case ApprovalStatus.REJECTED:
        if (approving) {
          throw AdminErrors.approvalAlreadyDecided(request.id, request.status);
        }
        return request;
      case ApprovalStatus.FAILED:
        if (!approving) {
          throw AdminErrors.approvalAlreadyDecided(request.id, request.status);
        }
        throw AdminErrors.approvalActionFailed(
          request.id,
          request.executionError ?? { code: 'UNKNOWN', message: 'The action failed.' },
        );
      case ApprovalStatus.EXPIRED:
        throw AdminErrors.approvalExpired(request.id);
      default:
        throw AdminErrors.approvalAlreadyDecided(request.id, request.status);
    }
  }

  private commitDecision(
    request: ApprovalRequestProps,
    input: DecideApprovalInput & { checkerUserId: string; reason: string | null },
  ): Promise<ApprovalRequestProps | null> {
    const status =
      input.decision === ApprovalDecision.APPROVE ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
    return this.uow.run(async (tx) => {
      const decided = await this.approvals.transition(
        request.id,
        ApprovalStatus.PENDING,
        {
          status,
          decidedByUserId: input.checkerUserId,
          decidedAt: new Date(),
          decisionNote: input.reason,
        },
        tx,
      );
      if (!decided) {
        return null;
      }
      await this.audit.record(
        {
          actorUserId: input.checkerUserId,
          action: status === ApprovalStatus.APPROVED ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
          resourceType: 'ApprovalRequest',
          resourceId: request.id,
          context: {
            actionType: request.actionType,
            entityType: request.entityType,
            entityId: request.entityId,
            // Both parties (module-16 §13).
            requestedBy: request.requestedByUserId,
            decidedBy: input.checkerUserId,
            reason: input.reason,
          },
          ip: input.ip ?? null,
        },
        tx,
      );
      await this.outbox.write(
        approvalDecidedEvent({
          approvalId: request.id,
          actionType: request.actionType,
          entityId: request.entityId,
          status,
          requestedBy: request.requestedByUserId,
          decidedBy: input.checkerUserId,
        }),
        tx as OutboxCapableClient,
      );
      return decided;
    });
  }

  private async run(
    request: ApprovalRequestProps,
    input: DecideApprovalInput & { checkerUserId: string },
  ): Promise<ApprovalRequestProps> {
    const action = this.registry.find(request.actionType);
    if (!action) {
      // A deployment that no longer registers the action. The request stays APPROVED and
      // unexecuted, so it can still run once the action is back; nothing is guessed.
      throw new Error(`Maker-checker action ${request.actionType} is not registered.`);
    }

    let result: Record<string, unknown>;
    try {
      result = await action.execute(request.payload, {
        approvalId: request.id,
        idempotencyKey: executionIdempotencyKey(request.id),
        makerUserId: request.requestedByUserId,
        actorUserId: input.checkerUserId,
        actorPermissions: input.checkerPermissions,
      });
    } catch (err) {
      if (err instanceof ApiException) {
        // The owning module refused: a domain rule, final. Recorded, then reported.
        const cause = { code: err.code, message: err.message };
        await this.recordOutcome(request, input, { failed: cause });
        throw AdminErrors.approvalActionFailed(request.id, cause);
      }
      // Infrastructure, not a decision: left APPROVED and unexecuted for a resumed run.
      throw err;
    }

    return (await this.recordOutcome(request, input, { result })) ?? request;
  }

  private recordOutcome(
    request: ApprovalRequestProps,
    input: DecideApprovalInput & { checkerUserId: string },
    outcome: { result: Record<string, unknown> } | { failed: { code: string; message: string } },
  ): Promise<ApprovalRequestProps | null> {
    return this.uow.run(async (tx) => {
      const failed = 'failed' in outcome;
      const updated = await this.approvals.transition(
        request.id,
        ApprovalStatus.APPROVED,
        failed
          ? { status: ApprovalStatus.FAILED, executionError: outcome.failed }
          : { executedAt: new Date(), executionResult: outcome.result },
        tx,
        { unexecuted: true },
      );
      if (!updated) {
        // A concurrent resumed run recorded it first; the owning module ran it once either way.
        return this.approvals.findById(request.id, tx);
      }
      await this.audit.record(
        {
          actorUserId: input.checkerUserId,
          action: failed ? 'APPROVAL_EXECUTION_FAILED' : 'APPROVAL_EXECUTED',
          resourceType: 'ApprovalRequest',
          resourceId: request.id,
          context: {
            actionType: request.actionType,
            entityId: request.entityId,
            requestedBy: request.requestedByUserId,
            decidedBy: updated.decidedByUserId,
            executedBy: input.checkerUserId,
            idempotencyKey: executionIdempotencyKey(request.id),
            ...(failed ? { error: outcome.failed } : { result: outcome.result }),
          },
          ip: input.ip ?? null,
        },
        tx,
      );
      return updated;
    });
  }
}
