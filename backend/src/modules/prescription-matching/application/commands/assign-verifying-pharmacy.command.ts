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

export interface AssignVerifyingPharmacyInput {
  prescriptionId: string;
  pharmacyId: string;
}

/**
 * `AssignVerifyingPharmacyCommand` (module-05 §4, §20 Decision 6) — an internal port method (no
 * HTTP surface in Slice 1), called once a pharmacy has been chosen for an Rx line (§4's
 * "match -> assign -> verify" sequencing: matching runs before verification because
 * `verifyingPharmacyId` is only known once `SelectMatchCommand` resolves a pharmacy). Legal from
 * `UPLOADED` (first assignment) or `CLARIFICATION_REQUESTED` (re-upload already routed back to
 * the same/a re-selected pharmacy) into `PENDING_VERIFICATION`
 * (`PrescriptionStatusPolicy`) — both transitions are already defined on the state machine, so
 * no new transition is added here. No domain event is emitted (not in
 * `00-domain-event-catalog.md`'s Module 05 row) and this is a lighter-weight linking action, not
 * a verification decision, so no `VerificationReview` row is written either.
 */
@Injectable()
export class AssignVerifyingPharmacyCommand {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: AssignVerifyingPharmacyInput): Promise<PrescriptionSnapshot> {
    const prescription = await this.prescriptions.findById(input.prescriptionId);
    if (!prescription) {
      throw PrescriptionMatchingErrors.notFound();
    }
    PrescriptionStatusPolicy.assertValidTransition(
      prescription.status,
      PrescriptionStatus.PENDING_VERIFICATION,
    );

    return runWithMatchRetry(this.uow, async (tx) => {
      const fresh = await this.prescriptions.findById(input.prescriptionId, tx);
      if (!fresh) {
        throw PrescriptionMatchingErrors.notFound();
      }
      PrescriptionStatusPolicy.assertValidTransition(
        fresh.status,
        PrescriptionStatus.PENDING_VERIFICATION,
      );

      await this.prescriptions.updateStatus(
        fresh.id,
        { status: PrescriptionStatus.PENDING_VERIFICATION, verifyingPharmacyId: input.pharmacyId },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: null,
          action: 'PRESCRIPTION_PHARMACY_ASSIGNED',
          resourceType: 'Prescription',
          resourceId: fresh.id,
          context: { pharmacyId: input.pharmacyId },
        },
        tx,
      );

      return (await this.prescriptions.findById(fresh.id, tx)) as PrescriptionSnapshot;
    });
  }
}
