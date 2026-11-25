import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditService } from '../../../shared/audit/audit.service';
import { AppLogger } from '../../../shared/logging/app-logger.service';
import { OutboxService } from '../../../shared/outbox/outbox.service';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { providerSuspendedEvent } from '../domain/events';

const BATCH_SIZE = 500;

/**
 * Work 160 (BRULE-08, module-09 §6): every day, an ACTIVE provider whose licence has expired is
 * suspended with `licenseStatus = EXPIRED`, audited (`PROVIDER_AUTO_SUSPENDED`) and announced, one
 * transaction each — the same pattern as Module 04's pharmacy sweeper. A renewed licence and an
 * administrator's reactivation restore it.
 */
@Injectable()
export class ProviderLicenceExpirySweeper {
  private readonly logger = new AppLogger();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(ProviderLicenceExpirySweeper.name);
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async run(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.healthcareProvider.findMany({
      where: { deletedAt: null, transactingStatus: 'ACTIVE', licenseExpiresAt: { lte: now } },
      select: { id: true },
      take: BATCH_SIZE,
    });
    let suspended = 0;
    for (const { id } of expired) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.healthcareProvider.updateMany({
          where: { id, transactingStatus: 'ACTIVE', licenseExpiresAt: { lte: now } },
          data: { transactingStatus: 'SUSPENDED', licenseStatus: 'EXPIRED' },
        });
        if (updated.count !== 1) return;
        await this.audit.record({ action: 'PROVIDER_AUTO_SUSPENDED', resourceType: 'HealthcareProvider', resourceId: id, context: { reason: 'LICENSE_EXPIRED' } }, tx);
        await this.outbox.write(providerSuspendedEvent({ providerId: id, reason: 'LICENSE_EXPIRED' }), tx as never);
        suspended += 1;
      });
    }
    this.logger.log(`Suspended ${suspended} healthcare providers with expired licences.`);
    return suspended;
  }
}
