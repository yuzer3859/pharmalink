import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  VerificationDecisionResult,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const ADMIN_VERIFICATION_APPROVED = 'ADMIN_VERIFICATION_APPROVED';

export interface ApproveVerificationInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  requestId: string;
  /** Licence expiry, when the approved document carries one (module-01 §9.3, BRULE-08). */
  expiresAt: Date | null;
  /** Reviewer's note. Recorded in this module's audit entry only — Module 01 keeps no approval reason. */
  reason: string | null;
  ip: string | null;
}

/**
 * `POST /admin/verifications/:id/approve` (module-16 §9.1, §11.1).
 *
 *     admin HTTP → PermissionsGuard(provider:verify:any) → this command
 *       → IIdentityAdminPort.approveVerification → Module 01 ApproveVerificationCommand
 *           (aggregate rule, PENDING compare-and-set, account lift, identity.provider.approved,
 *            Module 01 audit)
 *       → this module's audit entry for the admin action
 *
 * The command sets no status. It cannot: the port hands back a projection, and the only write it
 * can ask for is "approve this", which Module 01 performs under its own rules or refuses. A
 * refusal — already decided, self-review, not found — propagates as Module 01's own error, so the
 * administrator sees the same `BUSINESS_RULE_VIOLATION` / `FORBIDDEN` / `NOT_FOUND` that Module
 * 01's controller would answer.
 *
 * Two audit entries result, and that is the intent (§13 of the brief): Module 01's records the
 * domain fact (`identity.verification.approved`), this one records that an administrator took the
 * action through the admin surface, with the transition and their reason. Neither carries a
 * document, a storage reference or the Fayda identifier.
 *
 * Nothing is activated from here. A pharmacy becomes transacting through Module 04's own
 * `POST /pharmacy/activate`; a driver becomes dispatchable because Module 08's `IIdentityPort`
 * reads the approval live. Module 01's approval is the fact; the owning modules react to it.
 */
@Injectable()
export class ApproveVerificationCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ApproveVerificationInput): Promise<VerificationDecisionResult> {
    const decision = await this.identity.approveVerification({
      requestId: input.requestId,
      reviewerId: input.actorUserId,
      expiresAt: input.expiresAt,
      ip: input.ip,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_VERIFICATION_APPROVED,
      resourceType: 'verification_request',
      resourceId: decision.requestId,
      context: {
        verificationType: decision.type,
        previousStatus: decision.previousStatus,
        status: decision.status,
        subjectUserId: decision.subjectUserId,
        organizationId: decision.organizationId,
        expiresAt: decision.expiresAt?.toISOString() ?? null,
        reason: input.reason,
        decidedAt: decision.reviewedAt?.toISOString() ?? null,
      },
      ip: input.ip,
    });

    return decision;
  }
}
