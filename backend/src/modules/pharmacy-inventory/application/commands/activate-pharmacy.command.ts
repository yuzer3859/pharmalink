import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { pharmacyActivatedEvent } from '../../domain/events';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface ActivatePharmacyInput {
  actorUserId: string;
  pharmacyId: string;
}

/**
 * `POST /pharmacy/activate` (module-04 §4, §10.1) — an explicit, operator-invoked command
 * (§14.1), not an event reaction. Reads the current `Organization` via `IIdentityPort` and
 * snapshots `licenseExpiresAt` onto the `Pharmacy` row.
 */
@Injectable()
export class ActivatePharmacyCommand {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ActivatePharmacyInput): Promise<void> {
    const pharmacy = await this.pharmacies.findById(input.pharmacyId);
    if (!pharmacy) {
      throw PharmacyInventoryErrors.notFound('Pharmacy not found.');
    }

    const organization = await this.identity.getOrganization(pharmacy.organizationId);
    if (!organization) {
      throw PharmacyInventoryErrors.organizationNotFound();
    }

    await this.uow.run(async (tx) => {
      pharmacy.activate(organization.licenseExpiresAt);
      await this.pharmacies.update(pharmacy, tx);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PHARMACY_ACTIVATED',
          resourceType: 'Pharmacy',
          resourceId: pharmacy.id,
          context: { organizationId: pharmacy.organizationId },
        },
        tx,
      );

      await this.outbox.write(
        pharmacyActivatedEvent({ pharmacyId: pharmacy.id, organizationId: pharmacy.organizationId }),
        tx as never,
      );
    });
  }
}
