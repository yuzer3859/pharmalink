import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { providerApprovedEvent, userVerifiedEvent } from '../../domain/events';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';

export interface ApproveVerificationInput {
  requestId: string;
  reviewerId: string;
  /** Licence expiry, when the approved document carries one (module-01 §9.3, BRULE-08). */
  expiresAt?: Date | null;
  ip?: string | null;
}

/**
 * POST /admin/verification/{id}/approve (module-01 §9.2 step 7, §11.7). Separation of duties is
 * enforced in the aggregate: the reviewer may not be the subject. Approving a FAYDA request sets
 * the identity-assurance flag; approving a provider licence lifts a PENDING_APPROVAL account.
 */
@Injectable()
export class ApproveVerificationCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ApproveVerificationInput): Promise<void> {
    const request = await this.verifications.findById(input.requestId);
    if (!request) {
      throw ApiException.notFound('Verification request not found');
    }

    const user = await this.users.findById(request.userId);
    if (!user) {
      throw ApiException.notFound('User not found');
    }

    request.approve(input.reviewerId, input.expiresAt ?? null);
    // Compare-and-set on PENDING: two reviewers deciding the same request at once resolve to one
    // authoritative decision; the other surfaces `verificationClosed` (see `SaveExpectation`).
    await this.verifications.save(request, { status: VerificationStatus.PENDING });

    if (request.type === VerificationType.FAYDA) {
      user.markFaydaVerified();
      await this.users.save(user);
      await this.outbox.write(userVerifiedEvent({ userId: user.id, method: 'FAYDA' }));
    } else {
      user.approveProviderAccess();
      await this.users.save(user);
      await this.outbox.write(
        providerApprovedEvent({
          userId: user.id,
          organizationId: request.organizationId,
          verificationRequestId: request.id,
          verificationType: request.type,
          reviewerId: input.reviewerId,
        }),
      );
    }

    await this.audit.record({
      actorUserId: input.reviewerId,
      action: 'identity.verification.approved',
      resourceType: 'verification_request',
      resourceId: request.id,
      context: {
        type: request.type,
        subjectUserId: user.id,
        expiresAt: request.expiresAt?.toISOString() ?? null,
      },
      ip: input.ip ?? null,
    });
  }
}
