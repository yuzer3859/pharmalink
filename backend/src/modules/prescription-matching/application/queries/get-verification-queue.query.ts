import { Inject, Injectable } from '@nestjs/common';
import {
  IPrescriptionRepository,
  PagedResult,
  PRESCRIPTION_REPOSITORY,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';

export interface GetVerificationQueueInput {
  verifyingPharmacyId: string;
  page: number;
  size: number;
}

/**
 * `GET /pharmacy/verification/queue` (module-05 §10.2, §7.3) — pending prescriptions scoped to
 * the caller's pharmacy org (`verifyingPharmacyId`); org-scope itself is enforced by the
 * application layer resolving the caller's pharmacy org id before calling this (via
 * `IIdentityPort.getUserOrganizationIds()`, §7.3 — not this query's concern, mirrors Module 04's
 * `pharmacy:manage:org` pattern). No SLA sort in Slice 1 (§0.2) — the repository's own
 * `createdAt asc` ordering (oldest-first) is the only ordering.
 */
@Injectable()
export class GetVerificationQueueQuery {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
  ) {}

  async execute(input: GetVerificationQueueInput): Promise<PagedResult<PrescriptionSnapshot>> {
    return this.prescriptions.listVerificationQueue({
      verifyingPharmacyId: input.verifyingPharmacyId,
      page: input.page,
      size: input.size,
    });
  }
}
