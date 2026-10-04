import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Branch } from '../../domain/entities/branch.entity';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { BRANCH_REPOSITORY, IBranchRepository } from '../../domain/repositories/branch.repository';
import { IPharmacyRepository, PHARMACY_REPOSITORY } from '../../domain/repositories/pharmacy.repository';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface CreateBranchInput {
  pharmacyId: string;
  name: string;
  region?: string;
  city?: string;
  subcity?: string;
  woreda?: string;
  addressLine?: string;
  lat?: number;
  lng?: number;
  phone?: string;
}

/** `POST /pharmacy/branches` (module-04 §5.2, §10.1). */
@Injectable()
export class CreateBranchCommand {
  constructor(
    @Inject(PHARMACY_REPOSITORY) private readonly pharmacies: IPharmacyRepository,
    @Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
  ) {}

  async execute(input: CreateBranchInput): Promise<{ branchId: string }> {
    const pharmacy = await this.pharmacies.findById(input.pharmacyId);
    if (!pharmacy) {
      throw PharmacyInventoryErrors.notFound('Pharmacy not found.');
    }
    GeoPoint.assertBothOrNeither(input.lat, input.lng);

    const branch = Branch.create(randomUUID(), {
      pharmacyId: input.pharmacyId,
      name: input.name,
      region: input.region ?? null,
      city: input.city ?? null,
      subcity: input.subcity ?? null,
      woreda: input.woreda ?? null,
      addressLine: input.addressLine ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      phone: input.phone ?? null,
    });

    return this.uow.run(async (tx) => {
      await this.branches.create(branch, tx);
      return { branchId: branch.id };
    });
  }
}
