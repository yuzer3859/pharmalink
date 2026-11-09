import { Inject, Injectable } from '@nestjs/common';
import { PrescriptionStatus } from '../../../domain/enums';
import { IPrescriptionRepository, PRESCRIPTION_REPOSITORY } from '../../../domain/repositories/prescription.repository';
import { AssignVerifyingPharmacyCommand } from '../../commands/assign-verifying-pharmacy.command';
import { IPrescriptionReviewRoutingPort, PrescriptionReviewRouting } from './prescription-review-routing.port';

/** The newest prescriptions are what checkout is about; older ones are not routed by a quote. */
const RECENT = 20;

/** Work 109: see `IPrescriptionReviewRoutingPort`. */
@Injectable()
export class PrescriptionReviewRoutingAdapter implements IPrescriptionReviewRoutingPort {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY) private readonly prescriptions: IPrescriptionRepository,
    private readonly assign: AssignVerifyingPharmacyCommand,
  ) {}

  async routeForReview(input: { customerUserId: string; verifyingOrganizationId: string }): Promise<PrescriptionReviewRouting | null> {
    const { items: uploaded } = await this.prescriptions.listByCustomer({
      customerUserId: input.customerUserId,
      status: PrescriptionStatus.UPLOADED,
      page: 1,
      size: 1,
    });
    const next = uploaded.find((p) => !p.verifyingPharmacyId);
    if (next) {
      const routed = await this.assign.execute({ prescriptionId: next.id, pharmacyId: input.verifyingOrganizationId });
      return { prescriptionId: routed.id, status: routed.status, verifyingOrganizationId: input.verifyingOrganizationId, routedNow: true };
    }

    const { items: waiting } = await this.prescriptions.listByCustomer({
      customerUserId: input.customerUserId,
      status: PrescriptionStatus.PENDING_VERIFICATION,
      page: 1,
      size: RECENT,
    });
    const current = waiting.find((p) => p.verifyingPharmacyId);
    return current
      ? { prescriptionId: current.id, status: current.status, verifyingOrganizationId: current.verifyingPharmacyId!, routedNow: false }
      : null;
  }

  async verifyingOrganizationsFor(input: { customerUserId: string; prescriptionLineIds: string[] }): Promise<string[]> {
    const organizations = new Set<string>();
    for (const lineId of new Set(input.prescriptionLineIds)) {
      const line = await this.prescriptions.findLineById(lineId);
      if (!line) continue;
      const prescription = await this.prescriptions.findById(line.prescriptionId);
      if (prescription && prescription.customerUserId === input.customerUserId && prescription.verifyingPharmacyId) {
        organizations.add(prescription.verifyingPharmacyId);
      }
    }
    return [...organizations];
  }
}
