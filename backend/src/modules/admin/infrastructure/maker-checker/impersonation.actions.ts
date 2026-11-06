import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalEntityType } from '@prisma/client';
import {
  IDENTITY_IMPERSONATION_PORT,
  IIdentityImpersonationPort,
  SUPPORT_IMPERSONATE_PERMISSION,
} from '../../../identity/application/ports/inbound/identity-impersonation.port';
import { AdminErrors } from '../../domain/errors';
import { MakerCheckerActionRegistry } from '../../domain/maker-checker/maker-checker-action';

/** Work 85's action type (also `MAKER_CHECKER_ACTION_TYPES`). */
export const IMPERSONATION_START_ACTION = 'IMPERSONATION_START';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(payload: Record<string, unknown>): { targetUserId: string; reason: string } {
  const targetUserId = payload.targetUserId;
  if (typeof targetUserId !== 'string' || !UUID.test(targetUserId)) {
    throw AdminErrors.validation('targetUserId must be a UUID.', { field: 'targetUserId' });
  }
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (!reason) {
    throw AdminErrors.validation('A reason is required to view an account as its holder.', { field: 'reason' });
  }
  return { targetUserId, reason };
}

/**
 * Support "view as" (Work 85, module-16 F-AD-08) as a maker-checker action. An approval authorizes a
 * session in Module 01 for the administrator who asked; Module 01 refuses to authorize one the asker
 * approved themselves, so switching this action off in `approvals.makerCheckerActions` makes
 * impersonation impossible rather than single-actor.
 */
@Injectable()
export class ImpersonationActions implements OnModuleInit {
  constructor(
    private readonly registry: MakerCheckerActionRegistry,
    @Inject(IDENTITY_IMPERSONATION_PORT) private readonly impersonation: IIdentityImpersonationPort,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      type: IMPERSONATION_START_ACTION,
      entityType: ApprovalEntityType.IMPERSONATION,
      requiredPermission: SUPPORT_IMPERSONATE_PERMISSION,
      describe: (payload) => {
        const p = parse(payload);
        return { entityId: p.targetUserId, summary: `View account ${p.targetUserId} as its holder (read-only, 15 minutes)` };
      },
      execute: async (payload, ctx) => {
        const p = parse(payload);
        const session = await this.impersonation.authorize({
          targetUserId: p.targetUserId,
          requestedByUserId: ctx.makerUserId,
          approvedByUserId: ctx.actorUserId,
          // Direct execution (action switched off) has no approval: Module 01 then refuses, by design.
          approvalId: ctx.approvalId ?? `direct:${ctx.idempotencyKey}`,
          reason: p.reason,
        });
        return { sessionId: session.id, status: session.status, redeemBy: session.redeemBy.toISOString() };
      },
    });
  }
}
