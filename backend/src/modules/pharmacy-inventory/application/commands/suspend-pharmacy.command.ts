import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { pharmacySuspendedEvent } from '../../domain/events';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export const SUSPEND_REASON_MIN = 3;
export const SUSPEND_REASON_MAX = 500;

export interface SuspendPharmacyInput {
  actorUserId: string;
  pharmacyId: string;
  reason: string;
}

/**
 * Work 153: a platform administrator disables a pharmacy. It stops trading at once: the outbox
 * `PharmacySuspended` (reason `MANUAL`) drops it from search and tells its owner, the same way the
 * licence-expiry sweeper does. Audited as `PHARMACY_SUSPENDED` with the administrator's reason.
 * Enabling it again is `ActivatePharmacyCommand`, which re-checks the organisation and licence.
 */
@Injectable()
export class SuspendPharmacyCommand {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: SuspendPharmacyInput): Promise<{ suspended: boolean }> {
    const reason = input.reason.trim();
    return this.uow.run(async (tx) => {
      const pharmacy = await this.pharmacies.findByIdForUpdate(input.pharmacyId, tx);
      if (!pharmacy) throw PharmacyInventoryErrors.notFound('Pharmacy not found.');
      if (!pharmacy.suspendByAdmin()) return { suspended: false };
      await this.pharmacies.update(pharmacy, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PHARMACY_SUSPENDED',
          resourceType: 'Pharmacy',
          resourceId: pharmacy.id,
          context: { organizationId: pharmacy.organizationId, reason },
        },
        tx,
      );
      await this.outbox.write(pharmacySuspendedEvent({ pharmacyId: pharmacy.id, reason: 'MANUAL' }), tx as never);
      return { suspended: true };
    });
  }
}
