import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionStatus } from '../../domain/enums';
import {
  IPrescriptionRepository,
  PagedResult,
  PRESCRIPTION_REPOSITORY,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { DisplayStatus, PrescriptionDetailView } from './get-prescription.query';

export interface ListPrescriptionsInput {
  customerUserId: string;
  status?: PrescriptionStatus;
  page: number;
  size: number;
}

const TERMINAL_STATUSES = new Set(['REJECTED', 'CONSUMED']);

function computeDisplayStatus(prescription: PrescriptionSnapshot, now: Date): DisplayStatus {
  if (
    prescription.expiryDate &&
    prescription.expiryDate.getTime() <= now.getTime() &&
    !TERMINAL_STATUSES.has(prescription.status)
  ) {
    return 'EXPIRED';
  }
  return prescription.status;
}

/**
 * `GET /prescriptions` (module-05 §10.1) — lists the caller's own prescriptions only
 * (`prescription:read:own`, §7.2; ownership is the `customerUserId` filter itself, not a
 * post-hoc check, since this list is scoped by construction). Each item carries the same derived
 * `displayStatus` as `GetPrescriptionQuery` (§20 Decision 5). Not access-logged — FR-REC-06's
 * per-row audit trail is for `GET /prescriptions/:id` (single-resource reads), matching the
 * existing convention of other modules' list endpoints not being individually access-logged.
 */
@Injectable()
export class ListPrescriptionsQuery {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
  ) {}

  async execute(input: ListPrescriptionsInput): Promise<PagedResult<PrescriptionDetailView>> {
    const { items, total }: PagedResult<PrescriptionSnapshot> = await this.prescriptions.listByCustomer({
      customerUserId: input.customerUserId,
      status: input.status,
      page: input.page,
      size: input.size,
    });

    const now = new Date();
    return {
      items: items.map((p) => ({ ...p, displayStatus: computeDisplayStatus(p, now) })),
      total,
    };
  }
}
