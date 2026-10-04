import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { providerRejectedEvent } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';

export interface RejectVerificationInput {
  requestId: string;
  reviewerId: string;
  reason: string;
  ip?: string | null;
}

/**
 * POST /admin/verification/{id}/reject (module-01 §9.2 step 7, §11.7). The reason is recorded and
 * surfaced to the user, who may correct and resubmit. A rejected FAYDA check does not change the
 * account status — only provider approvals gate account activation.
 */
@Injectable()
export class RejectVerificationCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RejectVerificationInput): Promise<void> {
    const request = await this.verifications.findById(input.requestId);
    if (!request) {
      throw ApiException.notFound('Verification request not found');
    }

    request.reject(input.reviewerId, input.reason);
    // Compare-and-set on PENDING — see ApproveVerificationCommand.
    await this.verifications.save(request, { status: VerificationStatus.PENDING });

    if (request.type !== VerificationType.FAYDA) {
      const user = await this.users.findById(request.userId);
      if (user) {
        user.rejectProviderAccess();
        await this.users.save(user);
      }
    }

    await this.outbox.write(
      providerRejectedEvent({
        userId: request.userId,
        organizationId: request.organizationId,
        verificationRequestId: request.id,
        verificationType: request.type,
        reviewerId: input.reviewerId,
        reason: input.reason,
      }),
    );

    await this.audit.record({
      actorUserId: input.reviewerId,
      action: 'identity.verification.rejected',
      resourceType: 'verification_request',
      resourceId: request.id,
      context: { type: request.type, subjectUserId: request.userId, reason: input.reason },
      ip: input.ip ?? null,
    });
  }
}
