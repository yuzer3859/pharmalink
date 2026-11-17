export const DELIVERY_PAPER_REPOSITORY = Symbol('DELIVERY_PAPER_REPOSITORY');

/** Work 136: a job's original-paper-prescription round trip. */
export interface DeliveryPaperState {
  jobId: string;
  orderId: string;
  fulfillmentId: string;
  status: string;
  assignedDriverId: string | null;
  paperRxRequired: boolean;
  paperCollectedAt: Date | null;
  goodsReadyAt: Date | null;
}

/**
 * Work 136 (owner decision 2026-11-17): when the pharmacist requires the original paper, one driver
 * makes a round trip — customer (collect the paper) -> pharmacy (the pharmacist checks and keeps it;
 * the medicine is handed over once ready) -> customer. These columns sit beside the job's own state
 * machine rather than inside it: they gate two of its transitions and nothing else.
 */
export interface IDeliveryPaperRepository {
  findByJobId(jobId: string, tx?: unknown): Promise<DeliveryPaperState | null>;
  findByFulfillmentId(fulfillmentId: string, tx?: unknown): Promise<DeliveryPaperState | null>;
  markRequired(jobId: string, tx?: unknown): Promise<void>;
  /** Compare-and-set: records the collection once. `false` when already recorded. */
  markCollected(jobId: string, at: Date, tx?: unknown): Promise<boolean>;
  /** Records that the medicine is ready at the pharmacy (once). */
  markGoodsReady(jobId: string, at: Date, tx?: unknown): Promise<void>;
}
