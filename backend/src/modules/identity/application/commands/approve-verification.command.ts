import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { User } from '../../domain/entities/user.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { IdentityErrors } from '../../domain/errors';
import { providerApprovedEvent, userVerifiedEvent } from '../../domain/events';
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

export interface ApproveVerificationInput {
  requestId: string;
  reviewerId: string;
  /** Licence expiry, when the approved document carries one (module-01 §9.3, BRULE-08). */
  expiresAt?: Date | null;
  /** Approved licence number. Required for PHARMACY_LICENSE (Work 67); ignored otherwise. */
  licenseNumber?: string | null;
  ip?: string | null;
}

/**
 * POST /admin/verification/{id}/approve (module-01 §9.2 step 7, §11.7). Separation of duties is
 * enforced in the aggregate: the reviewer may not be the subject. Approving a FAYDA request sets
 * the identity-assurance flag; approving a provider licence lifts a PENDING_APPROVAL account.
 *
 * PHARMACY_LICENSE (Work 67) additionally requires the approved licence number and an expiry later
 * than now, and the request must be linked to an undeleted PHARMACY organisation owned by its
 * subject. In one Serializable transaction the request moves PENDING → APPROVED (compare-and-set)
 * with the licence recorded on it, the organisation receives the same licence number and expiry
 * and becomes ACTIVE, the account lift, the ProviderApproved event and the audit entries are
 * written. Any failure rolls all of it back. The Pharmacy aggregate (Module 04) is not activated:
 * that remains the explicit `POST /pharmacy/activate`.
 */
@Injectable()
export class ApproveVerificationCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
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

    if (request.type === VerificationType.PHARMACY_LICENSE) {
      return this.approvePharmacyLicense(request, user, input);
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

  private async approvePharmacyLicense(
    request: VerificationRequest,
    user: User,
    input: ApproveVerificationInput,
  ): Promise<void> {
    // Closed request, self-review, licence number and expiry are checked by the aggregate.
    request.approvePharmacyLicense(input.reviewerId, {
      licenseNumber: input.licenseNumber ?? '',
      expiresAt: input.expiresAt as Date,
    });
    const organization = await resolveLicenseOrganization(this.organizations, request);
    const licenseNumber = request.licenseNumber as string;
    const licenseExpiresAt = request.expiresAt as Date;

    await this.uow.run(
      async (tx) => {
        await this.verifications.save(request, { status: VerificationStatus.PENDING }, tx);
        const updated = await this.organizations.recordApprovedLicense(
          { organizationId: organization.id, ownerUserId: request.userId, licenseNumber, licenseExpiresAt },
          tx,
        );
        if (!updated) {
          // Deleted or re-owned since it was read: approve nothing.
          throw IdentityErrors.licenseOrganizationMismatch('ORGANIZATION_NOT_FOUND');
        }
        user.approveProviderAccess();
        await this.users.save(user, tx);
        await this.outbox.write(
          providerApprovedEvent({
            userId: user.id,
            organizationId: organization.id,
            verificationRequestId: request.id,
            verificationType: request.type,
            reviewerId: input.reviewerId,
          }),
          tx as never,
        );
        await this.audit.record(
          {
            actorUserId: input.reviewerId,
            action: 'identity.verification.approved',
            resourceType: 'verification_request',
            resourceId: request.id,
            context: {
              type: request.type,
              subjectUserId: user.id,
              organizationId: organization.id,
              licenseNumber,
              expiresAt: licenseExpiresAt.toISOString(),
            },
            ip: input.ip ?? null,
          },
          tx,
        );
        await this.audit.record(
          {
            actorUserId: input.reviewerId,
            action: 'identity.organization.license_approved',
            resourceType: 'organization',
            resourceId: organization.id,
            context: {
              verificationRequestId: request.id,
              previousStatus: organization.status,
              status: 'ACTIVE',
              licenseNumber,
              licenseExpiresAt: licenseExpiresAt.toISOString(),
            },
            ip: input.ip ?? null,
          },
          tx,
        );
      },
      { isolation: 'serializable' },
    );
  }
}
