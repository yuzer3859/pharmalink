import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { PrescriptionStatus } from '../../domain/enums';
import { PrescriptionMatchingErrors } from '../../domain/errors';
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
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface RequestClarificationInput {
  prescriptionId: string;
  reviewerUserId: string;
  message: string;
}

const PHARMACIST_ROLE_KEY = 'PHARMACIST';

/**
 * `POST /pharmacy/verification/:id/clarify` (module-05 §5.2, §10.2, §12 "Reject prescription"'s
 * sibling). Transitions `PENDING_VERIFICATION -> CLARIFICATION_REQUESTED`. **No domain event is
 * emitted** — `00-domain-event-catalog.md`'s Module 05 row has no cataloged event for this
 * action (§10.2's explicit note: adding one now with no cataloged consumer would repeat Module
 * 04's own explicitly-avoided "dead code event" mistake). Still runs at `Serializable` isolation
 * with the bounded retry wrapper (§2.1.1) since it co-locates a state change with an audit entry.
 */
@Injectable()
export class RequestClarificationCommand {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async execute(input: RequestClarificationInput): Promise<PrescriptionSnapshot> {
    const message = (input.message ?? '').trim();
    if (message.length < 3 || message.length > 500) {
      throw PrescriptionMatchingErrors.validation(
        'Clarification message must be between 3 and 500 characters.',
        { field: 'message' },
      );
    }

    const prescription = await this.prescriptions.findById(input.prescriptionId);
    if (!prescription) {
      throw PrescriptionMatchingErrors.notFound();
    }
    PrescriptionStatusPolicy.assertValidTransition(
      prescription.status,
      PrescriptionStatus.CLARIFICATION_REQUESTED,
    );

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
      PrescriptionStatusPolicy.assertValidTransition(
        fresh.status,
        PrescriptionStatus.CLARIFICATION_REQUESTED,
      );

      await this.prescriptions.updateStatus(
        fresh.id,
        { status: PrescriptionStatus.CLARIFICATION_REQUESTED },
        tx,
      );

      await this.verifications.create(
        {
          prescriptionId: fresh.id,
          reviewerUserId: input.reviewerUserId,
          pharmacyId: fresh.verifyingPharmacyId,
          decision: 'CLARIFICATION',
          reason: message,
        },
        tx,
      );

      await this.audit.record(
        {
          actorUserId: input.reviewerUserId,
          action: 'PRESCRIPTION_CLARIFICATION_REQUESTED',
          resourceType: 'Prescription',
          resourceId: fresh.id,
          context: { message },
        },
        tx,
      );

      return (await this.prescriptions.findById(fresh.id, tx)) as PrescriptionSnapshot;
    });
  }
}
