import { Inject, Injectable } from '@nestjs/common';
import {
  IPharmacyOperationsReadPort,
  PHARMACY_OPERATIONS_READ_PORT,
  PharmacyOperationsFilter,
  PharmacyOperationsPage,
  PharmacyOperationsView,
} from '../../../pharmacy-inventory/application/ports/inbound/pharmacy-operations-read.port';
import { AdminErrors } from '../../domain/errors';

export const DEFAULT_PHARMACY_OPERATIONS_PAGE = 1;
export const DEFAULT_PHARMACY_OPERATIONS_PAGE_SIZE = 20;
export const MAX_PHARMACY_OPERATIONS_PAGE_SIZE = 100;

export interface ListPharmacyOperationsInput extends PharmacyOperationsFilter {
  page?: number;
  size?: number;
}

/**
 * `GET /admin/operations/pharmacies` (module-16 Work 47): live pharmacies newest first, each with its
 * eligibility and branch/listing counts, through Module 04's `PHARMACY_OPERATIONS_READ_PORT`. Paging
 * clamped to 1..100 (default 20). Every rule is Module 04's. Read-only; not audited.
 */
@Injectable()
export class ListPharmacyOperationsQuery {
  constructor(@Inject(PHARMACY_OPERATIONS_READ_PORT) private readonly pharmacies: IPharmacyOperationsReadPort) {}

  execute(input: ListPharmacyOperationsInput): Promise<PharmacyOperationsPage> {
    const page = input.page && Number.isFinite(input.page) && input.page > 0 ? Math.floor(input.page) : DEFAULT_PHARMACY_OPERATIONS_PAGE;
    const size =
      input.size && Number.isFinite(input.size) && input.size > 0
        ? Math.min(Math.floor(input.size), MAX_PHARMACY_OPERATIONS_PAGE_SIZE)
        : DEFAULT_PHARMACY_OPERATIONS_PAGE_SIZE;
    const filter: PharmacyOperationsFilter = {
      transactingStatus: input.transactingStatus,
      eligible: input.eligible,
      hasPurchasableInventory: input.hasPurchasableInventory,
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
    };
    return this.pharmacies.listPharmacies(filter, page, size);
  }
}

/** `GET /admin/operations/pharmacies/:pharmacyId` (module-16 Work 47): one live pharmacy. Unknown or deleted → 404. */
@Injectable()
export class GetPharmacyOperationsQuery {
  constructor(@Inject(PHARMACY_OPERATIONS_READ_PORT) private readonly pharmacies: IPharmacyOperationsReadPort) {}

  async execute(pharmacyId: string): Promise<PharmacyOperationsView> {
    const pharmacy = await this.pharmacies.getPharmacy(pharmacyId);
    if (!pharmacy) throw AdminErrors.pharmacyNotFound();
    return pharmacy;
  }
}
