import { Inject, Injectable } from '@nestjs/common';
import {
  BRANCH_OPERATIONS_READ_PORT,
  BranchOperationsFilter,
  BranchOperationsPage,
  BranchOperationsView,
  IBranchOperationsReadPort,
} from '../../../pharmacy-inventory/application/ports/inbound/branch-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_BRANCH_OPERATIONS_PAGE = 1;
export const DEFAULT_BRANCH_OPERATIONS_PAGE_SIZE = 20;
export const MAX_BRANCH_OPERATIONS_PAGE_SIZE = 100;

export interface ListBranchOperationsInput extends BranchOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/branches` (module-16 Work 48): live branches of live pharmacies, newest
 * first, with their pharmacy's eligibility and listing counts, through Module 04's
 * `BRANCH_OPERATIONS_READ_PORT`. Paging clamped to 1..100 (default 20). Read-only; not audited.
 */
@Injectable()
export class ListBranchOperationsQuery {
  constructor(@Inject(BRANCH_OPERATIONS_READ_PORT) private readonly branches: IBranchOperationsReadPort) {}

  execute(input: ListBranchOperationsInput): Promise<BranchOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_BRANCH_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_BRANCH_OPERATIONS_PAGE_SIZE)
        : DEFAULT_BRANCH_OPERATIONS_PAGE_SIZE;
    const filter: BranchOperationsFilter = {
      pharmacyId: input.pharmacyId,
      isActive: input.isActive,
      hasPurchasableInventory: input.hasPurchasableInventory,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.branches.listBranches(filter, page, size);
  }
}

/** `GET /admin/operations/branches/:branchId` (module-16 Work 48): one live branch. Unknown or deleted → 404. */
@Injectable()
export class GetBranchOperationsQuery {
  constructor(@Inject(BRANCH_OPERATIONS_READ_PORT) private readonly branches: IBranchOperationsReadPort) {}

  async execute(branchId: string): Promise<BranchOperationsView> {
    const branch = await this.branches.getBranch(branchId);
    if (!branch) throw AdminErrors.branchNotFound();
    return branch;
  }
}
