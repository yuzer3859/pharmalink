import { Branch } from '../entities/branch.entity';
import { BranchOperatingHourProps } from '../entities/branch-operating-hour.entity';

export const BRANCH_REPOSITORY = Symbol('BRANCH_REPOSITORY');

export interface IBranchRepository {
  findById(id: string, tx?: unknown): Promise<Branch | null>;
  findManyByPharmacy(pharmacyId: string, tx?: unknown): Promise<Branch[]>;
  create(branch: Branch, tx?: unknown): Promise<void>;
  update(branch: Branch, tx?: unknown): Promise<void>;
  replaceOperatingHours(
    branchId: string,
    hours: Array<Omit<BranchOperatingHourProps, 'id' | 'branchId'>>,
    tx?: unknown,
  ): Promise<void>;
  listOperatingHours(branchId: string, tx?: unknown): Promise<BranchOperatingHourProps[]>;
}
