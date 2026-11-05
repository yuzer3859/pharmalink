import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { CONFIG_PORT, IConfigPort } from '../../../../shared/config/config.port';
import {
  DEFAULT_APPROVALS_TTL_HOURS,
  MAX_APPROVALS_TTL_HOURS,
  MIN_APPROVALS_TTL_HOURS,
} from '../../../../shared/config/approvals.config';
import { OutboxCapableClient, OutboxService } from '../../../../shared/outbox/outbox.service';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { AdminErrors } from '../../domain/errors';
import { approvalRequestedEvent } from '../../domain/events';
import {
  ApprovalRequestProps,
  MAX_APPROVAL_REASON_LENGTH,
  MAX_APPROVAL_SUMMARY_LENGTH,
} from '../../domain/maker-checker/approval-request';
import {
  APPROVAL_REQUEST_REPOSITORY,
  IApprovalRequestRepository,
} from '../../domain/maker-checker/approval-request.repository';
import { MakerCheckerActionRegistry } from '../../domain/maker-checker/maker-checker-action';
import { ADMIN_UNIT_OF_WORK, IAdminUnitOfWork } from '../ports/unit-of-work.port';

export interface SubmitSensitiveActionInput {
  actionType: string;
  payload: Record<string, unknown>;
  /** From the verified token. */
  makerUserId: string;
  makerPermissions: readonly string[];
  /** The maker's `Idempotency-Key`. */
  idempotencyKey: string;
  reason?: string | null;
  ip?: string | null;
}

export type SubmitSensitiveActionResult =
  | { outcome: 'EXECUTED'; result: Record<string, unknown> }
  | { outcome: 'PENDING_APPROVAL'; approval: ApprovalRequestProps };

/**
 * The one call a maker-facing route makes for a sensitive action (Work 82, NFR-SEC-06).
 *
 * If `approvals.makerCheckerActions` lists the action, a PENDING request is recorded and returned
 * (the route answers `MAKER_CHECKER_PENDING`); otherwise the action runs at once through the same
 * registered executor, with the maker's authority and key. Either way the owning module does the
 * work, so the two paths cannot disagree about what the action is.
 */
@Injectable()
export class MakerCheckerGate {
  constructor(
    private readonly registry: MakerCheckerActionRegistry,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
    @Inject(ADMIN_UNIT_OF_WORK) private readonly uow: IAdminUnitOfWork,
    @Inject(CONFIG_PORT) private readonly config: IConfigPort,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Whether the action currently needs a second administrator. */
  requiresApproval(actionType: string): boolean {
    const configured = this.config.get<unknown>('approvals.makerCheckerActions');
    return Array.isArray(configured) && configured.includes(actionType);
  }

  async submit(input: SubmitSensitiveActionInput): Promise<SubmitSensitiveActionResult> {
    const action = this.registry.find(input.actionType);
    if (!action) {
      throw AdminErrors.unknownApprovalAction(input.actionType);
    }
    const makerUserId = (input.makerUserId ?? '').trim();
    if (!makerUserId) {
      throw AdminErrors.validation('makerUserId is required.', { field: 'makerUserId' });
    }
    const idempotencyKey = (input.idempotencyKey ?? '').trim();
    if (!idempotencyKey) {
      throw AdminErrors.validation('An idempotency key is required.', { field: 'idempotencyKey' });
    }
    // Only someone who could do it alone may ask for it.
    if (!hasPermission(input.makerPermissions, action.requiredPermission)) {
      throw AdminErrors.approvalPermissionMissing(action.requiredPermission);
    }
    const reason = normaliseReason(input.reason);
    const { entityId, summary } = action.describe(input.payload);

    const gated =
      this.requiresApproval(action.type) && (action.needsApproval ? await action.needsApproval(input.payload) : true);
    if (!gated) {
      const result = await action.execute(input.payload, {
        approvalId: null,
        idempotencyKey,
        makerUserId,
        actorUserId: makerUserId,
        actorPermissions: input.makerPermissions,
      });
      return { outcome: 'EXECUTED', result };
    }

    const replay = await this.approvals.findByMakerKey(makerUserId, action.type, idempotencyKey);
    if (replay) {
      return { outcome: 'PENDING_APPROVAL', approval: this.assertSameRequest(replay, entityId, input.payload) };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlHours() * 60 * 60 * 1000);
    const id = randomUUID();

    const outcome = await this.uow.run(async (tx) => {
      const inserted = await this.approvals.insert(
        {
          id,
          actionType: action.type,
          entityType: action.entityType,
          entityId,
          requiredPermission: action.requiredPermission,
          requestedByUserId: makerUserId,
          makerIdempotencyKey: idempotencyKey,
          summary: summary.slice(0, MAX_APPROVAL_SUMMARY_LENGTH),
          reason,
          payload: input.payload,
          expiresAt,
        },
        tx,
      );
      if ('conflict' in inserted) {
        return inserted;
      }
      const created = inserted.created;
      await this.audit.record(
        {
          actorUserId: makerUserId,
          action: 'APPROVAL_REQUESTED',
          resourceType: 'ApprovalRequest',
          resourceId: created.id,
          context: {
            actionType: created.actionType,
            entityType: created.entityType,
            entityId: created.entityId,
            requiredPermission: created.requiredPermission,
            summary: created.summary,
            reason: created.reason,
            payload: created.payload,
            expiresAt: created.expiresAt.toISOString(),
          },
          ip: input.ip ?? null,
        },
        tx,
      );
      await this.outbox.write(
        approvalRequestedEvent({
          approvalId: created.id,
          actionType: created.actionType,
          entityType: created.entityType,
          entityId: created.entityId,
          requestedBy: makerUserId,
          expiresAt: created.expiresAt.toISOString(),
        }),
        tx as OutboxCapableClient,
      );
      return inserted;
    });

    if ('created' in outcome) {
      return { outcome: 'PENDING_APPROVAL', approval: outcome.created };
    }
    if (outcome.conflict === 'MAKER_KEY') {
      // A concurrent retry of the same request won the insert.
      const raced = await this.approvals.findByMakerKey(makerUserId, action.type, idempotencyKey);
      if (raced) {
        return { outcome: 'PENDING_APPROVAL', approval: this.assertSameRequest(raced, entityId, input.payload) };
      }
    }
    const open = await this.approvals.findPendingForTarget(action.type, entityId);
    throw AdminErrors.approvalAlreadyPending(open?.id ?? '');
  }

  private assertSameRequest(
    existing: ApprovalRequestProps,
    entityId: string,
    payload: Record<string, unknown>,
  ): ApprovalRequestProps {
    if (existing.entityId !== entityId || stableJson(existing.payload) !== stableJson(payload)) {
      throw AdminErrors.approvalIdempotencyConflict();
    }
    return existing;
  }

  private ttlHours(): number {
    const raw = Number(this.config.get<number>('approvals.ttlHours'));
    if (!Number.isInteger(raw) || raw < MIN_APPROVALS_TTL_HOURS || raw > MAX_APPROVALS_TTL_HOURS) {
      return DEFAULT_APPROVALS_TTL_HOURS;
    }
    return raw;
  }
}

function normaliseReason(reason: string | null | undefined): string | null {
  const value = (reason ?? '').trim();
  if (!value) {
    return null;
  }
  if (value.length > MAX_APPROVAL_REASON_LENGTH) {
    throw AdminErrors.validation(`reason must be at most ${MAX_APPROVAL_REASON_LENGTH} characters.`, {
      field: 'reason',
    });
  }
  return value;
}

/** JSON with sorted keys, so two equal payloads compare equal whatever their key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
