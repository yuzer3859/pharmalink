import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { PrescriptionStatus } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import {
  IPrescriptionRepository,
  PRESCRIPTION_REPOSITORY,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import { PrescriptionStatusPolicy } from '../../domain/services/prescription-status-policy';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface ReuploadPrescriptionInput {
  prescriptionId: string;
  customerUserId: string;
  fileRef: string;
  encryptionKeyRef?: string;
  fileType: string;
}

/**
 * `POST /prescriptions/:id/reupload` (module-05 §10.1) — the customer's response to a
 * `CLARIFICATION_REQUESTED` prescription. Per `PrescriptionStatusPolicy`'s own doc comment, the
 * target status "depends on whether a pharmacy has already been assigned" — this command is
 * exactly that "not-yet-built application-layer command" the policy anticipated: it transitions
 * back to `PENDING_VERIFICATION` if `verifyingPharmacyId` is already set (the same pharmacy re-
 * reviews the re-uploaded file), or `UPLOADED` if no pharmacy has been assigned yet (§4's
 * "match -> assign -> verify" sequencing means a fresh upload may be re-clarified before any
 * pharmacy was ever chosen). Ownership-mismatch and "does not exist" are both collapsed into the
 * same generic not-found response (no existence leakage, §14). Single `Serializable` transaction
 * with the bounded retry wrapper (§2.1.1) — the new file fields + status update + audit entry
 * commit together; no domain event is cataloged for this action (§9), mirroring
 * `RequestClarificationCommand`'s own "no event" note.
 */
@Injectable()
export class ReuploadPrescriptionCommand {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ReuploadPrescriptionInput): Promise<PrescriptionSnapshot> {
    const prescription = await this.prescriptions.findById(input.prescriptionId);
    if (!prescription || prescription.customerUserId !== input.customerUserId) {
      throw PrescriptionMatchingErrors.notFound();
    }

    const target = prescription.verifyingPharmacyId
      ? PrescriptionStatus.PENDING_VERIFICATION
      : PrescriptionStatus.UPLOADED;
    PrescriptionStatusPolicy.assertValidTransition(prescription.status, target);

    return runWithMatchRetry(this.uow, async (tx) => {
      const fresh = await this.prescriptions.findById(input.prescriptionId, tx);
      if (!fresh || fresh.customerUserId !== input.customerUserId) {
        throw PrescriptionMatchingErrors.notFound();
      }
      const freshTarget = fresh.verifyingPharmacyId
        ? PrescriptionStatus.PENDING_VERIFICATION
        : PrescriptionStatus.UPLOADED;
      PrescriptionStatusPolicy.assertValidTransition(fresh.status, freshTarget);

      await this.prescriptions.updateStatus(
        fresh.id,
        {
          status: freshTarget,
          fileRef: input.fileRef,
          encryptionKeyRef: input.encryptionKeyRef ?? null,
          fileType: input.fileType,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.customerUserId,
          action: 'PRESCRIPTION_REUPLOADED',
          resourceType: 'Prescription',
          resourceId: fresh.id,
          context: { targetStatus: freshTarget },
        },
        tx,
      );

      return (await this.prescriptions.findById(fresh.id, tx)) as PrescriptionSnapshot;
    });
  }
}
