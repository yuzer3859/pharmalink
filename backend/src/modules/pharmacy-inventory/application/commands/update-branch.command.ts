import { Inject, Injectable } from '@nestjs/common';
import { Branch } from '../../domain/entities/branch.entity';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { BRANCH_REPOSITORY, IBranchRepository } from '../../domain/repositories/branch.repository';
import { GeoPoint } from '../../domain/value-objects/geo-point.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface UpdateBranchInput {
  pharmacyId: string;
  branchId: string;
  name?: string;
  region?: string;
  city?: string;
  subcity?: string;
  woreda?: string;
  addressLine?: string;
  lat?: number;
  lng?: number;
  phone?: string;
  isActive?: boolean;
}

/** `PATCH /pharmacy/branches/:id` (module-04 §5.2, §10.1). */
@Injectable()
export class UpdateBranchCommand {
  constructor(
    @Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
  ) {}

  async execute(input: UpdateBranchInput): Promise<void> {
    const branch = await this.branches.findById(input.branchId);
    if (!branch || branch.pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.branchNotFound();
    }
    if (input.lat !== undefined || input.lng !== undefined) {
      GeoPoint.assertBothOrNeither(input.lat, input.lng);
    }

    const props = branch.toProps();
    const merged = {
      ...props,
      name: input.name ?? props.name,
      region: input.region ?? props.region,
      city: input.city ?? props.city,
      subcity: input.subcity ?? props.subcity,
      woreda: input.woreda ?? props.woreda,
      addressLine: input.addressLine ?? props.addressLine,
      lat: input.lat ?? props.lat,
      lng: input.lng ?? props.lng,
      phone: input.phone ?? props.phone,
      isActive: input.isActive ?? props.isActive,
      updatedAt: new Date(),
    };

    await this.uow.run(async (tx) => {
      await this.branches.update(Branch.rehydrate(merged), tx);
    });
  }
}
