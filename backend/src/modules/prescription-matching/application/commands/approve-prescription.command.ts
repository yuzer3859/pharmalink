import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { OutboxService } from '../../../../shared/outbox/outbox.service';
import { PrescriptionMatchingErrors } from '../../domain/errors';
import { PrescriptionStatus } from '../../domain/enums';
import { prescriptionApprovedEvent } from '../../domain/events';
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
import { CATALOG_PORT, ICatalogPort } from '../ports/outbound/catalog.port';
import { IIdentityPort, IDENTITY_PORT } from '../ports/outbound/identity.port';
import { IUnitOfWork, UNIT_OF_WORK } from '../ports/unit-of-work.port';
import { runWithMatchRetry } from '../support/match-retry';

export interface ApproveLineInput {
  rawText?: string;
  catalogProductId: string;
  approvedQuantity: number;
  refillsAllowed: number;
  isSingleUse: boolean;
}

export interface ApprovePrescriptionInput {
  prescriptionId: string;
  reviewerUserId: string;
  lines: ApproveLineInput[];
  legibilityOk: boolean;
  validityOk: boolean;
}

const PHARMACIST_ROLE_KEY = 'PHARMACIST';

/**
 * `POST /pharmacy/verification/:id/approve` (module-05 §5.2, §10.2, §12 "Approve prescription").
 * Order of checks (§5.2 business validation): prescription must be `PENDING_VERIFICATION`
 * (`PrescriptionStatusPolicy`, else `409 INVALID_PRESCRIPTION_STATE_TRANSITION`) -> reviewer must
 * pass `VerificationPolicy.canReview()` (else `403 VERIFICATION_FORBIDDEN`) -> every
 * `catalogProductId` resolves via `ICatalogPort.getProduct()` to a non-deleted, `ACTIVE` product
 * (else `404 CATALOG_PRODUCT_NOT_FOUND`). Single `Serializable` transaction: prescription status
 * update, one `PrescriptionLine` insert per approved line (`remainingDispensable =
 * approvedQuantity`), `VerificationReview` insert, audit entry, outbox `PrescriptionApproved`
 * (§2.1.1/§12).
 */
@Injectable()
export class ApprovePrescriptionCommand {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    @Inject(VERIFICATION_REPOSITORY) private readonly verifications: IVerificationRepository,
    @Inject(CATALOG_PORT) private readonly catalog: ICatalogPort,
    @Inject(IDENTITY_PORT) private readonly identity: IIdentityPort,
    @Inject(UNIT_OF_WORK) private readonly uow: IUnitOfWork,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: ApprovePrescriptionInput): Promise<PrescriptionSnapshot> {
    const prescription = await this.prescriptions.findById(input.prescriptionId);
    if (!prescription) {
      throw PrescriptionMatchingErrors.notFound();
    }

    PrescriptionStatusPolicy.assertValidTransition(prescription.status, PrescriptionStatus.APPROVED);

    const isPharmacistAtPharmacy = prescription.verifyingPharmacyId
      ? await this.identity.hasRoleAtOrganization(
          input.reviewerUserId,
          prescription.verifyingPharmacyId,
          PHARMACIST_ROLE_KEY,
        )
      : false;
    VerificationPolicy.assertCanReview(input.reviewerUserId, prescription, isPharmacistAtPharmacy);

    for (const line of input.lines) {
      const product = await this.catalog.getProduct(line.catalogProductId);
      if (!product || product.status !== 'ACTIVE') {
        throw PrescriptionMatchingErrors.catalogProductNotFound();
      }
    }

    return runWithMatchRetry(this.uow, async (tx) => {
      // Re-read fresh inside the transaction — never trust the pre-transaction read for the
      // actual state mutation (§2.1.1/§8.1's "recompute inside the transaction" discipline).
      const fresh = await this.prescriptions.findById(input.prescriptionId, tx);
      if (!fresh) {
        throw PrescriptionMatchingErrors.notFound();
      }
      PrescriptionStatusPolicy.assertValidTransition(fresh.status, PrescriptionStatus.APPROVED);

      await this.prescriptions.updateStatus(
        fresh.id,
        {
          status: PrescriptionStatus.APPROVED,
          verifiedByUserId: input.reviewerUserId,
          verifiedAt: new Date(),
        },
        tx,
      );

      const createdLines = await this.prescriptions.createApprovedLines(
        fresh.id,
        input.lines.map((line) => ({
          catalogProductId: line.catalogProductId,
          rawText: line.rawText ?? null,
          prescribedQuantity: line.approvedQuantity,
          refillsAllowed: line.refillsAllowed,
          isSingleUse: line.isSingleUse,
        })),
        tx,
      );

      await this.verifications.create(
        {
          prescriptionId: fresh.id,
          reviewerUserId: input.reviewerUserId,
          pharmacyId: fresh.verifyingPharmacyId,
          decision: 'APPROVED',
          legibilityOk: input.legibilityOk,
          validityOk: input.validityOk,
        },
        tx,
      );

      const eventLines = createdLines.map((line) => ({
        lineId: line.id,
        catalogProductId: line.catalogProductId as string,
        approvedQuantity: line.prescribedQuantity as number,
      }));

      await this.audit.record(
        {
          actorUserId: input.reviewerUserId,
          action: 'PRESCRIPTION_APPROVED',
          resourceType: 'Prescription',
          resourceId: fresh.id,
          context: { lines: eventLines },
        },
        tx,
      );

      await this.outbox.write(
        prescriptionApprovedEvent({ prescriptionId: fresh.id, lines: eventLines }),
        tx as never,
      );

      return (await this.prescriptions.findById(fresh.id, tx)) as PrescriptionSnapshot;
    });
  }
}
