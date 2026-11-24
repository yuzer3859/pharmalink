import { Inject, Injectable } from '@nestjs/common';
import { ActivatePharmacyCommand } from '../../commands/activate-pharmacy.command';
import { RegisterPharmacyCommand } from '../../commands/register-pharmacy.command';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../../domain/repositories/pharmacy.repository';

export const PHARMACY_ONBOARDING_PORT = Symbol('PHARMACY_ONBOARDING_PORT');

/**
 * Work 154: Module 04's steps of registering a pharmacy, for an administrator acting on an
 * owner's behalf. `register` is `RegisterPharmacyCommand` as the owner (only the organisation's
 * owner may register it); `activate` is `ActivatePharmacyCommand`, which checks the approved,
 * current licence. `findByOrganization` lets a retried registration skip a step already done.
 */
export interface IPharmacyOnboardingPort {
  findByOrganization(organizationId: string): Promise<{ pharmacyId: string; transactingStatus: string } | null>;
  register(input: { ownerUserId: string; organizationId: string; displayName: string }): Promise<{ pharmacyId: string }>;
  activate(input: { actorUserId: string; pharmacyId: string }): Promise<void>;
}

@Injectable()
export class PharmacyOnboardingAdapter implements IPharmacyOnboardingPort {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    private readonly registerPharmacy: RegisterPharmacyCommand,
    private readonly activatePharmacy: ActivatePharmacyCommand,
  ) {}

  async findByOrganization(organizationId: string) {
    const pharmacy = await this.pharmacies.findByOrganizationId(organizationId);
    if (!pharmacy) return null;
    const props = pharmacy.toProps();
    return { pharmacyId: props.id, transactingStatus: props.transactingStatus };
  }

  async register(input: { ownerUserId: string; organizationId: string; displayName: string }) {
    const { pharmacyId } = await this.registerPharmacy.execute({ actorUserId: input.ownerUserId, organizationId: input.organizationId, displayName: input.displayName });
    return { pharmacyId };
  }

  async activate(input: { actorUserId: string; pharmacyId: string }) {
    await this.activatePharmacy.execute({ actorUserId: input.actorUserId, pharmacyId: input.pharmacyId });
  }
}
