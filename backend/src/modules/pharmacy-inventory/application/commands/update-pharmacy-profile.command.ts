import { Inject, Injectable } from '@nestjs/common';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface UpdatePharmacyProfileInput {
  pharmacyId: string;
  displayName?: string;
  logoUrl?: string;
  description?: string;
}

/** `PATCH /pharmacy/profile` (module-04 §5.1, §10.1). */
@Injectable()
export class UpdatePharmacyProfileCommand {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
  ) {}

  async execute(input: UpdatePharmacyProfileInput): Promise<void> {
    const pharmacy = await this.pharmacies.findById(input.pharmacyId);
    if (!pharmacy) {
      throw PharmacyInventoryErrors.notFound('Pharmacy not found.');
    }

    await this.uow.run(async (tx) => {
      pharmacy.applyProfileEdits({
        displayName: input.displayName,
        logoUrl: input.logoUrl,
        description: input.description,
      });
      await this.pharmacies.update(pharmacy, tx);
    });
  }
}
