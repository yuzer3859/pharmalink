import { Inject, Injectable } from '@nestjs/common';
import { PharmacyInventoryErrors } from '../../domain/errors';
import { BRANCH_REPOSITORY, IBranchRepository } from '../../domain/repositories/branch.repository';
import { OperatingHours } from '../../domain/value-objects/operating-hours.vo';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/outbound/unit-of-work.port';

export interface SetOperatingHoursInput {
  pharmacyId: string;
  branchId: string;
  hours: Array<{ weekday: number; openTime?: string; closeTime?: string; isClosed: boolean }>;
}

/** `PUT /pharmacy/branches/:id/hours` — full-week replace (module-04 §5.2, §10.1). */
@Injectable()
export class SetOperatingHoursCommand {
  constructor(
    @Inject(BRANCH_REPOSITORY) private readonly branches: IBranchRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
  ) {}

  async execute(input: SetOperatingHoursInput): Promise<void> {
    const branch = await this.branches.findById(input.branchId);
    if (!branch || branch.pharmacyId !== input.pharmacyId) {
      throw PharmacyInventoryErrors.branchNotFound();
    }

    const validated = input.hours.map((h) =>
      OperatingHours.of({
        weekday: h.weekday,
        openTime: h.openTime ?? null,
        closeTime: h.closeTime ?? null,
        isClosed: h.isClosed,
      }).props,
    );

    await this.uow.run(async (tx) => {
      await this.branches.replaceOperatingHours(
        input.branchId,
        validated.map((h) => ({
          weekday: h.weekday,
          openTime: h.openTime ?? null,
          closeTime: h.closeTime ?? null,
          isClosed: h.isClosed,
        })),
        tx,
      );
    });
  }
}
