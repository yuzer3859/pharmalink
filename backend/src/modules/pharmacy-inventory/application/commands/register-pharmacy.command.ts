import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { Pharmacy } from '../../domain/entities/pharmacy.entity';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IDENTITY_PORT, IIdentityPort } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface RegisterPharmacyInput {
  actorUserId: string;
  organizationId: string;
  displayName: string;
  logoUrl?: string;
  description?: string;
}

/**
 * `POST /pharmacy/register` (module-04 §5.1, §10.1). Module 04 never writes `organizations` —
 * it only reads via `IIdentityPort` (§2, §14.1).
 */
@Injectable()
export class RegisterPharmacyCommand {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RegisterPharmacyInput): Promise<{ pharmacyId: string; transactingStatus: string }> {
    const organization = await this.identity.getOrganization(input.organizationId);
    if (!organization || organization.type !== 'PHARMACY') {
      throw PharmacyInventoryErrors.organizationNotFound();
    }

    const owner = await this.identity.getOrganizationOwner(input.organizationId);
    if (!owner || owner.userId !== input.actorUserId) {
      throw PharmacyInventoryErrors.forbidden('Only the organization owner may register this pharmacy.');
    }

    const existing = await this.pharmacies.findByOrganizationId(input.organizationId);
    if (existing) {
      throw PharmacyInventoryErrors.pharmacyAlreadyRegistered();
    }

    const pharmacy = Pharmacy.register(randomUUID(), {
      organizationId: input.organizationId,
      displayName: input.displayName,
      logoUrl: input.logoUrl,
      description: input.description,
    });

    return this.uow.run(async (tx) => {
      await this.pharmacies.create(pharmacy, tx);
      await this.audit.record(
        {
          actorUserId: input.actorUserId,
          action: 'PHARMACY_REGISTERED',
          resourceType: 'Pharmacy',
          resourceId: pharmacy.id,
          context: { organizationId: input.organizationId },
        },
        tx,
      );
      const props = pharmacy.toProps();
      return { pharmacyId: props.id, transactingStatus: props.transactingStatus };
    });
  }
}
