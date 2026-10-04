import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { pharmacySuspendedEvent } from '../../domain/events';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../../application/ports/outbound/unit-of-work.port';

/**
 * BR-PH-03/BRULE-08 (module-04 §4). Daily cron: finds `Pharmacy` rows where `licenseExpiresAt
 * <= now` and `transactingStatus = ACTIVE`, transitions them to `SUSPENDED`/`licenseStatus =
 * EXPIRED`, writes an audit entry (`PHARMACY_AUTO_SUSPENDED`) and outbox `PharmacySuspended`
 * event, all in one transaction per pharmacy (§12).
 */
@Injectable()
export class LicenseExpirySweeper {
  private readonly logger = new AppLogger();

  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.logger.setContext(LicenseExpirySweeper.name);
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async run(): Promise<number> {
    const now = new Date();
    const expired = await this.pharmacies.findExpiredActive(now, 500);
    for (const pharmacy of expired) {
      await this.uow.run(async (tx) => {
        pharmacy.suspendForExpiredLicense(now);
        await this.pharmacies.update(pharmacy, tx);
        await this.audit.record(
          {
            action: 'PHARMACY_AUTO_SUSPENDED',
            resourceType: 'Pharmacy',
            resourceId: pharmacy.id,
            context: { reason: 'LICENSE_EXPIRED' },
          },
          tx,
        );
        await this.outbox.write(
          pharmacySuspendedEvent({ pharmacyId: pharmacy.id, reason: 'LICENSE_EXPIRED' }),
          tx as never,
        );
      });
    }
    this.logger.log(`Suspended ${expired.length} pharmacies with expired licenses.`);
    return expired.length;
  }
}
