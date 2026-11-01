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

export interface ActivatePharmacyResult {
  /** False when the pharmacy was already transacting on the same approved licence (a repeat). */
  activated: boolean;
}

/**
 * `POST /pharmacy/activate` (module-04 §4, §10.1) — an explicit, operator-invoked command
 * (§14.1), not an event reaction. Licence approval in Module 01 activates the Organization, never
 * this aggregate.
 *
 * Activation requires persisted evidence, read through `IIdentityPort` (Work 67): an undeleted
 * PHARMACY organisation that is ACTIVE, with a licence number and an unexpired expiry, and an
 * APPROVED PHARMACY_LICENSE request for that organisation and its owner carrying the same licence
 * number and expiry. Nothing about the licence comes from the request body. If any check fails the
 * pharmacy is left untouched and no audit entry or event is written.
 *
 * Runs in one transaction holding the pharmacy row lock and a share lock on the organisation row,
 * so a concurrent activation or licence change is serialized. A repeat for a pharmacy already
 * transacting on the same licence expiry changes nothing and emits nothing; a pharmacy suspended
 * for an expired licence is restored once a newer licence is approved and an operator activates it.
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

  async execute(input: ActivatePharmacyInput): Promise<ActivatePharmacyResult> {
    return this.uow.run(async (tx) => {
      const now = new Date();
      const pharmacy = await this.pharmacies.findByIdForUpdate(input.pharmacyId, tx);
      if (!pharmacy) {
        throw PharmacyInventoryErrors.notFound('Pharmacy not found.');
      }

      const organization = await this.identity.getOrganization(pharmacy.organizationId, tx);
      if (!organization) {
        throw PharmacyInventoryErrors.organizationNotFound();
      }
      if (organization.type !== 'PHARMACY') {
        throw PharmacyInventoryErrors.activationRefused('ORGANIZATION_NOT_PHARMACY');
      }
      if (organization.status !== 'ACTIVE') {
        throw PharmacyInventoryErrors.activationRefused('ORGANIZATION_NOT_ACTIVE', {
          organizationStatus: organization.status,
        });
      }
      if (!organization.licenseNumber || !organization.licenseExpiresAt) {
        throw PharmacyInventoryErrors.activationRefused('LICENSE_MISSING');
      }
      if (organization.licenseExpiresAt.getTime() <= now.getTime()) {
        throw PharmacyInventoryErrors.licenseExpired();
      }

      const licence = await this.identity.getCurrentPharmacyLicense(organization.id, tx);
      if (
        !licence ||
        licence.organizationId !== organization.id ||
        licence.userId !== organization.ownerUserId ||
        licence.licenseNumber !== organization.licenseNumber ||
        licence.expiresAt.getTime() !== organization.licenseExpiresAt.getTime() ||
        licence.expiresAt.getTime() <= now.getTime()
      ) {
        throw PharmacyInventoryErrors.activationRefused('LICENSE_NOT_APPROVED');
      }

      if (pharmacy.isActiveWithLicense(licence.expiresAt)) {
        return { activated: false };
      }

      pharmacy.activate(licence.expiresAt, now);
      await this.pharmacies.update(pharmacy, tx);

      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PHARMACY_ACTIVATED',
          resourceType: 'Pharmacy',
          resourceId: pharmacy.id,
          context: {
            organizationId: pharmacy.organizationId,
            verificationRequestId: licence.verificationRequestId,
            licenseExpiresAt: licence.expiresAt.toISOString(),
          },
        },
        tx,
      );

      await this.outbox.write(
        pharmacyActivatedEvent({ pharmacyId: pharmacy.id, organizationId: pharmacy.organizationId }),
        tx as never,
      );
      return { activated: true };
    });
  }
}
