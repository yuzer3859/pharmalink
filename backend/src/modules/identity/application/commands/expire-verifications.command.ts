import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { licenseExpiredEvent } from '../../domain/events';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';
import { SuspendUserCommand } from './suspend-user.command';

const BATCH_SIZE = 100;

/**
 * Licence-expiry sweep (module-01 §9.3, BRULE-08): an approved licence that has passed its
 * `expiresAt` flips to EXPIRED and the provider is suspended until they resubmit. Idempotent and
 * batched so it can run on a timer or be invoked once from a test/CLI.
 */
@Injectable()
export class ExpireVerificationsCommand {
  constructor(
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    private readonly suspendUser: SuspendUserCommand,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Returns the number of licences expired in this pass. */
  async execute(now: Date = new Date()): Promise<number> {
    const expired = await this.verifications.listExpired(now, BATCH_SIZE);

    let processed = 0;
    for (const request of expired) {
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
}
