import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { providerRejectedEvent } from '../../domain/events';
import {
  IOrganizationRepository,
  ORGANIZATION_REPOSITORY,
} from '../../domain/repositories/organization.repository';
import { IUserRepository, USER_REPOSITORY } from '../../domain/repositories/user.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { resolveLicenseOrganization } from '../services/license-organization';

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
 *
 * PHARMACY_LICENSE (Work 67): the request must be linked to an undeleted PHARMACY organisation
 * owned by its subject. An initial application's organisation moves PENDING_APPROVAL → REJECTED;
 * an organisation in any other status — in particular an ACTIVE one renewing a licence that is
 * still valid — keeps its status, licence number and expiry. Rejected application data never
 * reaches the organisation. The request transition (compare-and-set), the organisation update,
 * the event and the audit entries commit together in one Serializable transaction.
 */
@Injectable()
export class RejectVerificationCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RejectVerificationInput): Promise<void> {
    const request = await this.verifications.findById(input.requestId);
    if (!request) {
      throw ApiException.notFound('Verification request not found');
    }

    request.reject(input.reviewerId, input.reason);
    if (request.type === VerificationType.PHARMACY_LICENSE) {
      return this.rejectPharmacyLicense(request, input);
    }
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

  private async rejectPharmacyLicense(
    request: VerificationRequest,
    input: RejectVerificationInput,
  ): Promise<void> {
    const organization = await resolveLicenseOrganization(this.organizations, request);
    const user = await this.users.findById(request.userId);

    await this.uow.run(
      async (tx) => {
        await this.verifications.save(request, { status: VerificationStatus.PENDING }, tx);
        const applicationRejected = await this.organizations.rejectPendingApplication(organization.id, tx);
        if (user) {
          user.rejectProviderAccess();
          await this.users.save(user, tx);
        }
        await this.outbox.write(
          providerRejectedEvent({
            userId: request.userId,
            organizationId: organization.id,
            verificationRequestId: request.id,
            verificationType: request.type,
            reviewerId: input.reviewerId,
            reason: input.reason,
          }),
          tx as never,
        );
        await this.audit.record(
          {
            actorUserId: input.reviewerId,
            action: 'identity.verification.rejected',
            resourceType: 'verification_request',
            resourceId: request.id,
            context: {
              type: request.type,
              subjectUserId: request.userId,
              organizationId: organization.id,
              reason: input.reason,
            },
            ip: input.ip ?? null,
          },
          tx,
        );
        if (applicationRejected) {
          await this.audit.record(
            {
              actorUserId: input.reviewerId,
              action: 'identity.organization.application_rejected',
              resourceType: 'organization',
              resourceId: organization.id,
              context: { verificationRequestId: request.id, previousStatus: 'PENDING_APPROVAL', status: 'REJECTED' },
              ip: input.ip ?? null,
            },
            tx,
          );
        }
      },
      { isolation: 'serializable' },
    );
  }
}
