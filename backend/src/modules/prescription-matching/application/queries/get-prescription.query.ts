import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionAccessType } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import {
  IPrescriptionRepository,
  PRESCRIPTION_REPOSITORY,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';

export interface GetPrescriptionInput {
  prescriptionId: string;
  requestingUserId: string;
  /** `true` for a platform admin — bypasses the owner/reviewer-scoped access check (§2.2). */
  isAdmin?: boolean;
  accessType?: PrescriptionAccessType;
}

/** Derived, non-persisted status shown to callers (§10.1, §20 Decision 5, §3.11 invariant 4) —
 * `EXPIRED` if `expiryDate` is past and the stored status is not already terminal, else the
 * stored status verbatim. No schema change, no cron sweeper. */
export type DisplayStatus = PrescriptionSnapshot['status'] | 'EXPIRED';

export interface PrescriptionDetailView extends PrescriptionSnapshot {
  displayStatus: DisplayStatus;
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

const PHARMACIST_ROLE_KEY = 'PHARMACIST';

/**
 * `GET /prescriptions/:id` (module-05 §10.1, §14). **Audited on every call, allow and deny**
 * (`PrescriptionAccessLog`, FR-REC-06) — access denials return a generic 403 without leaking
 * existence (`00-shared-conventions.md` §1, §10.4). Visible to: the uploading customer
 * (`customerUserId`), staff holding `PHARMACIST` at the `verifyingPharmacyId` organization, or an
 * admin (§2.2's Slice-1-scoped owner-only policy — no beneficiary-delegated access yet).
 */
@Injectable()
export class GetPrescriptionQuery {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
  ) {}

  async execute(input: GetPrescriptionInput): Promise<PrescriptionDetailView> {
    const accessType = input.accessType ?? PrescriptionAccessType.VIEW;
    const prescription = await this.prescriptions.findById(input.prescriptionId);

    if (!prescription) {
      // No row to log an access-log entry against — nothing to allow/deny yet; the generic
      // not-found response itself is the privacy-preserving behavior here.
      throw PrescriptionMatchingErrors.notFound();
    }

    const isOwner = prescription.customerUserId === input.requestingUserId;
    const isReviewingPharmacist = prescription.verifyingPharmacyId
      ? await this.identity.hasRoleAtOrganization(
          input.requestingUserId,
          prescription.verifyingPharmacyId,
          PHARMACIST_ROLE_KEY,
        )
      : false;
    const allowed = Boolean(input.isAdmin) || isOwner || isReviewingPharmacist;

    await this.prescriptions.logAccess({
      prescriptionId: prescription.id,
      actorUserId: input.requestingUserId,
      role: input.isAdmin ? 'ADMIN' : isOwner ? 'CUSTOMER' : isReviewingPharmacist ? 'PHARMACIST' : null,
      accessType,
      outcome: allowed ? 'ALLOW' : 'DENY',
    });

    if (!allowed) {
      throw PrescriptionMatchingErrors.notFound();
    }

    return { ...prescription, displayStatus: computeDisplayStatus(prescription, new Date()) };
  }
}
