import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { ApiException } from '../../../../shared/errors/api-exception';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { VerificationStatus, VerificationType } from '../../domain/enums';
import { licenseExpiredEvent } from '../../domain/events';
import {
  IOrganizationRepository,
  ORGANIZATION_REPOSITORY,
} from '../../domain/repositories/organization.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { SuspendUserCommand } from './suspend-user.command';

const BATCH_SIZE = 100;

/**
 * Licence-expiry sweep (module-01 §9.3, BRULE-08): an approved licence that has passed its
 * `expiresAt` flips to EXPIRED and the provider is suspended until they resubmit. Idempotent and
 * batched so it can run on a timer or be invoked once from a test/CLI. `expiresAt <= now` is expired.
 *
 * A PHARMACY_LICENSE is organisation-scoped (Work 67) and never suspends the owner's account: an
 * owner may hold other organisations whose licences are valid. Instead, in one Serializable
 * transaction, the request moves APPROVED → EXPIRED (compare-and-set) and its organisation moves
 * ACTIVE → SUSPENDED — but only while the organisation's stored licence number and expiry are
 * still this request's. A renewal approved since then replaced them, so the expiry of the older,
 * superseded request leaves the organisation alone. The Pharmacy aggregate stops being eligible
 * on its own: its licence expiry (copied at activation) has passed, and Module 04's
 * `LicenseExpirySweeper` suspends it.
 */
@Injectable()
export class ExpireVerificationsCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizations: IOrganizationRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly suspendUser: SuspendUserCommand,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the number of licences expired in this pass. */
  async execute(now: Date = new Date()): Promise<number> {
    const expired = await this.verifications.listExpired(now, BATCH_SIZE);

    let processed = 0;
    for (const request of expired) {
      if (request.type === VerificationType.PHARMACY_LICENSE) {
        if (await this.expirePharmacyLicense(request, now)) processed += 1;
        continue;
      }

      request.markExpired(now);
      await this.verifications.save(request);

      await this.outbox.write(
        licenseExpiredEvent({
          userId: request.userId,
          organizationId: request.organizationId,
          verificationRequestId: request.id,
          verificationType: request.type,
          expiredAt: now.toISOString(),
        }),
      );

      // A terminal account (deleted/deactivated) legitimately refuses suspension — the licence is
      // still expired, so record the outcome and keep sweeping rather than aborting the batch.
      try {
        await this.suspendUser.execute({
          targetUserId: request.userId,
          reason: `LICENSE_EXPIRED:${request.type}`,
          actorUserId: null,
        });
      } catch {
        await this.audit.record({
          actorUserId: null,
          action: 'identity.license.expiry_suspend_skipped',
          resourceType: 'verification_request',
          resourceId: request.id,
          context: { subjectUserId: request.userId },
        });
      }

      processed += 1;
    }

    return processed;
  }

  /** False when a concurrent sweep already expired the request (the compare-and-set lost). */
  private async expirePharmacyLicense(request: VerificationRequest, now: Date): Promise<boolean> {
    request.markExpired(now);
    const expiresAt = request.expiresAt as Date;
    try {
      await this.uow.run(
        async (tx) => {
          await this.verifications.save(request, { status: VerificationStatus.APPROVED }, tx);
          const suspended = request.organizationId
            ? await this.organizations.suspendForExpiredLicense(
                {
                  organizationId: request.organizationId,
                  licenseNumber: request.licenseNumber,
                  licenseExpiresAt: expiresAt,
                  now,
                },
                tx,
              )
            : false;
          await this.outbox.write(
            licenseExpiredEvent({
              userId: request.userId,
              organizationId: request.organizationId,
              verificationRequestId: request.id,
              verificationType: request.type,
              expiredAt: now.toISOString(),
            }),
            tx as never,
          );
          await this.audit.record(
            {
              actorUserId: null,
              action: suspended
                ? 'identity.organization.suspended_license_expired'
                : 'identity.license.expired_without_suspension',
              resourceType: suspended ? 'organization' : 'verification_request',
              resourceId: suspended ? request.organizationId : request.id,
              context: {
                verificationRequestId: request.id,
                organizationId: request.organizationId,
                subjectUserId: request.userId,
                expiresAt: expiresAt.toISOString(),
              },
            },
            tx,
          );
        },
        { isolation: 'serializable' },
      );
    } catch (err) {
      if (err instanceof ApiException) return false;
      throw err;
    }
    return true;
  }
}
