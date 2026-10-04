import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import {
  IDENTITY_ADMIN_PORT,
  IIdentityAdminPort,
  VerificationDecisionResult,
} from '../../../identity/application/ports/inbound/identity-admin.port';

export const ADMIN_VERIFICATION_REJECTED = 'ADMIN_VERIFICATION_REJECTED';

export interface RejectVerificationInput {
  /** From the verified access token, never from a request body. */
  actorUserId: string;
  requestId: string;
  /** Required by Module 01's aggregate; surfaced to the applicant, who may correct and resubmit. */
  reason: string;
  ip: string | null;
}

/**
 * `POST /admin/verifications/:id/reject` (module-16 §9.1). The mirror of
 * `ApproveVerificationCommand`: permission → port → Module 01's `RejectVerificationCommand` →
 * this module's audit entry. See that command for why the flow is shaped this way.
 *
 * The reason is forwarded verbatim. Module 01 requires one and rejects a blank; the HTTP DTO
 * applies the same bounds Module 01's own route does, so a request that reaches here carries a
 * reason Module 01 will accept — and if it somehow does not, Module 01's refusal is the answer.
 */
@Injectable()
export class RejectVerificationCommand {
  constructor(
    @Inject(IDENTITY_ADMIN_PORT) private readonly identity: IIdentityAdminPort,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RejectVerificationInput): Promise<VerificationDecisionResult> {
    const decision = await this.identity.rejectVerification({
      requestId: input.requestId,
      reviewerId: input.actorUserId,
      reason: input.reason,
      ip: input.ip,
    });

    await this.audit.record({
      actorUserId: input.actorUserId,
      action: ADMIN_VERIFICATION_REJECTED,
      resourceType: 'verification_request',
      resourceId: decision.requestId,
      context: {
        verificationType: decision.type,
        previousStatus: decision.previousStatus,
        status: decision.status,
        subjectUserId: decision.subjectUserId,
        organizationId: decision.organizationId,
        reason: input.reason,
        decidedAt: decision.reviewedAt?.toISOString() ?? null,
      },
      ip: input.ip,
    });

    return decision;
  }
}
