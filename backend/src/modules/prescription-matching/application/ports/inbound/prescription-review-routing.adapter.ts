import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionStatus } from '../../../domain/enums';
import { PrescriptionMatchingErrors } from '../../../domain/errors';
import { IPrescriptionRepository, PRESCRIPTION_REPOSITORY, PrescriptionSnapshot } from '../../../domain/repositories/prescription.repository';
import { ApprovePrescriptionCommand } from '../../commands/approve-prescription.command';
import { AssignVerifyingPharmacyCommand } from '../../commands/assign-verifying-pharmacy.command';
import { RejectPrescriptionCommand } from '../../commands/reject-prescription.command';
import { ApprovedRxLine, IPrescriptionReviewRoutingPort, RequestedRxItem } from './prescription-review-routing.port';

/** Work 129: see `IPrescriptionReviewRoutingPort`. */
@Injectable()
export class PrescriptionReviewRoutingAdapter implements IPrescriptionReviewRoutingPort {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    private readonly assign: AssignVerifyingPharmacyCommand,
    private readonly approve: ApprovePrescriptionCommand,
    private readonly reject: RejectPrescriptionCommand,
  ) {}

  async assertAttachable(input: { customerUserId: string; prescriptionId: string }): Promise<void> {
    await this.attachable(input.customerUserId, input.prescriptionId);
  }

  async attachToOrder(input: {
    customerUserId: string;
    prescriptionId: string;
    verifyingOrganizationId: string;
    requestedItems: RequestedRxItem[];
  }): Promise<void> {
    await this.attachable(input.customerUserId, input.prescriptionId);
    await this.assign.execute({
      prescriptionId: input.prescriptionId,
      pharmacyId: input.verifyingOrganizationId,
      requestedItems: input.requestedItems,
    });
  }

  async approveForOrder(input: {
    prescriptionId: string;
    reviewerUserId: string;
    items: Array<{ catalogProductId: string; quantity: number }>;
    legibilityOk: boolean;
    validityOk: boolean;
  }): Promise<ApprovedRxLine[]> {
    const current = await this.prescriptions.findById(input.prescriptionId);
    if (!current) throw PrescriptionMatchingErrors.notFound();
    if (current.status !== PrescriptionStatus.APPROVED) {
      await this.approve.execute({
        prescriptionId: input.prescriptionId,
        reviewerUserId: input.reviewerUserId,
        lines: input.items.map((item) => ({
          catalogProductId: item.catalogProductId,
          approvedQuantity: item.quantity,
          refillsAllowed: 0,
          isSingleUse: false,
        })),
        legibilityOk: input.legibilityOk,
        validityOk: input.validityOk,
      });
    }
    const lines = await this.prescriptions.findLinesByPrescriptionId(input.prescriptionId);
    const approved: ApprovedRxLine[] = [];
    for (const item of input.items) {
      const line = lines.find((l) => l.catalogProductId === item.catalogProductId);
      if (!line) throw PrescriptionMatchingErrors.validation('The approved prescription does not cover every prescription item on the order.');
      approved.push({ catalogProductId: item.catalogProductId, prescriptionLineId: line.id });
    }
    return approved;
  }

  async rejectForOrder(input: { prescriptionId: string; reviewerUserId: string; reason: string }): Promise<void> {
    const current = await this.prescriptions.findById(input.prescriptionId);
    if (!current) throw PrescriptionMatchingErrors.notFound();
    if (current.status === PrescriptionStatus.REJECTED) return;
    await this.reject.execute({ prescriptionId: input.prescriptionId, reviewerUserId: input.reviewerUserId, reason: input.reason });
  }

  /** The customer's own prescription, uploaded and not yet with any pharmacy; anything else is refused. */
  private async attachable(customerUserId: string, prescriptionId: string): Promise<PrescriptionSnapshot> {
    const prescription = await this.prescriptions.findById(prescriptionId);
    if (!prescription || prescription.customerUserId !== customerUserId) {
      throw PrescriptionMatchingErrors.notFound();
    }
    if (prescription.status !== PrescriptionStatus.UPLOADED || prescription.verifyingPharmacyId) {
      throw PrescriptionMatchingErrors.validation(
        'This prescription is already attached to another order. Upload the prescription again for this order.',
      );
    }
    return prescription;
  }
}
