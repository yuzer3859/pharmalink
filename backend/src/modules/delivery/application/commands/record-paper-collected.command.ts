import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../../shared/audit/audit.service';
import { DeliveryJobStatus } from '../../domain/enums';
import { DeliveryErrors } from '../../domain/errors';
import { DELIVERY_PAPER_REPOSITORY, DeliveryPaperState, IDeliveryPaperRepository } from '../../domain/repositories/delivery-paper.repository';
import { DRIVER_PROFILE_REPOSITORY, IDriverProfileRepository } from '../../domain/repositories/driver-profile.repository';

/**
 * Work 136 (owner decision 2026-11-17): the driver took the original paper prescription from the
 * customer — the first leg of the round trip, before going to the pharmacy. Only the job's driver,
 * only on a job that needs the paper, and only before arriving at the pharmacy. Repeating it is a
 * no-op.
 */
@Injectable()
export class RecordPaperCollectedCommand {
  constructor(
    @Inject(DELIVERY_PAPER_REPOSITORY) private readonly paper: IDeliveryPaperRepository,
    @Inject(DRIVER_PROFILE_REPOSITORY) private readonly profiles: IDriverProfileRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: { userId: string; jobId: string }, now = new Date()): Promise<DeliveryPaperState> {
    const profile = await this.profiles.findByUserId(input.userId);
    if (!profile) throw DeliveryErrors.driverProfileNotFound({ userId: input.userId });
    const job = await this.paper.findByJobId(input.jobId);
    if (!job || job.assignedDriverId !== profile.id) throw DeliveryErrors.notFound('Delivery job not found.', { jobId: input.jobId });
    if (!job.paperRxRequired) throw DeliveryErrors.validation('This delivery does not need the paper prescription.', { jobId: job.jobId });
    if (job.paperCollectedAt) return job;
    if (job.status !== DeliveryJobStatus.ASSIGNED) {
      throw DeliveryErrors.validation('Collect the paper prescription from the customer before going to the pharmacy.', { jobId: job.jobId, status: job.status });
    }
    if (await this.paper.markCollected(job.jobId, now)) {
      await this.audit.record({
        actorUserId: input.userId,
        action: 'DELIVERY_PAPER_RX_COLLECTED',
        resourceType: 'DeliveryJob',
        resourceId: job.jobId,
        context: { orderId: job.orderId, driverId: profile.id },
      });
    }
    return (await this.paper.findByJobId(job.jobId)) as DeliveryPaperState;
  }
}

/**
 * Work 136: the two transitions the paper gates, for `AdvanceDeliveryJobCommand`. Pure.
 *  - to the pharmacy (`ARRIVED_PICKUP`) only with the paper collected;
 *  - the medicine (`PICKED_UP`) only once the pharmacy marked the order ready — a paper job exists
 *    before that, so the driver can collect the paper while the pharmacy waits for it.
 */
export function paperRoundTripProblem(paper: DeliveryPaperState | null, to: DeliveryJobStatus): string | null {
  if (!paper?.paperRxRequired) return null;
  if (to === DeliveryJobStatus.ARRIVED_PICKUP && !paper.paperCollectedAt) {
    return 'Collect the original paper prescription from the customer first, then take it to the pharmacy.';
  }
  if (to === DeliveryJobStatus.PICKED_UP && !paper.goodsReadyAt) {
    return 'The pharmacy has not marked the order ready yet: wait while the pharmacist checks the paper and prepares the medicine.';
  }
  return null;
}
