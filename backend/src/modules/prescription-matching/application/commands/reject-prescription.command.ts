import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrescriptionStatus } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { prescriptionRejectedEvent } from '../../domain/events';
import {
  IPrescriptionRepository,
  PRESCRIPTION_REPOSITORY,
  PrescriptionSnapshot,
} from '../../domain/repositories/prescription.repository';
import {
  IVerificationRepository,
  VERIFICATION_REPOSITORY,
} from '../../domain/repositories/verification.repository';
import { PrescriptionStatusPolicy } from '../../domain/services/prescription-status-policy';
import { VerificationPolicy } from '../../domain/services/verification-policy';
import { RejectionReason } from '../../domain/value-objects/rejection-reason';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface RejectPrescriptionInput {
  prescriptionId: string;
  reviewerUserId: string;
  reason: string;
}

const PHARMACIST_ROLE_KEY = 'PHARMACIST';

/**
 * `POST /pharmacy/verification/:id/reject` (module-05 §5.2, §10.2, §12 "Reject prescription").
 * `RejectionReason.of()` is the single source of truth for BRULE-14's mandatory, non-empty
 * reason (§3.11 invariant 2) — enforced before any write, not just via DTO validation. Single
 * `Serializable` transaction: prescription status update (`+ rejectionReason`),
 * `VerificationReview` insert, audit entry, outbox `PrescriptionRejected` (§2.1.1/§12).
 */
@Injectable()
export class RejectPrescriptionCommand {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: RejectPrescriptionInput): Promise<PrescriptionSnapshot> {
    const reason = RejectionReason.of(input.reason);

    const prescription = await this.prescriptions.findById(input.prescriptionId);
    if (!prescription) {
      throw PrescriptionMatchingErrors.notFound();
    }
    PrescriptionStatusPolicy.assertValidTransition(prescription.status, PrescriptionStatus.REJECTED);

    const isPharmacistAtPharmacy = prescription.verifyingPharmacyId
      ? await this.identity.hasRoleAtOrganization(
          input.reviewerUserId,
          prescription.verifyingPharmacyId,
          PHARMACIST_ROLE_KEY,
        )
      : false;
    VerificationPolicy.assertCanReview(input.reviewerUserId, prescription, isPharmacistAtPharmacy);

    return runWithMatchRetry(this.uow, async (tx) => {
      const fresh = await this.prescriptions.findById(input.prescriptionId, tx);
      if (!fresh) {
        throw PrescriptionMatchingErrors.notFound();
      }
      PrescriptionStatusPolicy.assertValidTransition(fresh.status, PrescriptionStatus.REJECTED);

      await this.prescriptions.updateStatus(
        fresh.id,
        { status: PrescriptionStatus.REJECTED, rejectionReason: reason.value },
        tx,
      );

      await this.verifications.create(
        {
          prescriptionId: fresh.id,
          reviewerUserId: input.reviewerUserId,
          pharmacyId: fresh.verifyingPharmacyId,
          decision: 'REJECTED',
          reason: reason.value,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.reviewerUserId,
          action: 'PRESCRIPTION_REJECTED',
          resourceType: 'Prescription',
          resourceId: fresh.id,
          context: { reason: reason.value },
        },
        tx,
      );

      await this.outbox.write(
        prescriptionRejectedEvent({ prescriptionId: fresh.id, reason: reason.value }),
        tx as never,
      );

      return (await this.prescriptions.findById(fresh.id, tx)) as PrescriptionSnapshot;
    });
  }
}
