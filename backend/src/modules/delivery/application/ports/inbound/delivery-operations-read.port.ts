import { CodCollectionMethod, CodCollectionStatus, DeliveryJobStatus } from '../../../domain/enums';
import { DeliveryTimelineView } from '../../queries/get-delivery-job-status.query';

export const DELIVERY_OPERATIONS_READ_PORT = Symbol('DELIVERY_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export { CodCollectionMethod, CodCollectionStatus, DeliveryJobStatus } from '../../../domain/enums';
export type { DeliveryTimelineView } from '../../queries/get-delivery-job-status.query';

/** Every filter is a column of `delivery_jobs`, matched exactly or as a `createdAt` window. */
export interface DeliveryOperationsFilter {
  status?: DeliveryJobStatus;
  orderId?: string;
  isCod?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
}

/**
 * One delivery job as an operator sees it in a list — Module 08's own columns only. `status` is the
 * job's stored lifecycle status, never one derived from the order, its fulfillment, its payment or
 * its COD collection.
 */
export interface DeliveryOperationsSummary {
  deliveryJobId: string;
  orderId: string;
  fulfillmentId: string;
  pharmacyId: string;
  branchId: string;
  status: DeliveryJobStatus;
  /** `driver_profiles.id` — an opaque reference, never the driver's person — or `null` when unassigned. */
  driverProfileId: string | null;
  isCod: boolean;
  isColdChain: boolean;
  etaAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryOperationsPage {
  items: DeliveryOperationsSummary[];
  total: number;
  page: number;
  size: number;
}

/**
 * The job's COD collection as Module 08 records it: its own status, the declared figures and when
 * each step happened. No provider reference, settlement reference, remittance or reconciliation
 * detail, correction or dispute.
 */
export interface DeliveryOperationsCodView {
  collectionId: string;
  status: CodCollectionStatus;
  method: CodCollectionMethod;
  expectedAmount: number;
  collectedAmount: number;
  currency: string;
  collectedAt: Date;
  remittedAt: Date | null;
  reconciledAt: Date | null;
}

export interface DeliveryOperationsDetail extends DeliveryOperationsSummary {
  /** `GetDeliveryJobStatusQuery`'s own timeline (`deliveryTimelineOf`), from the same snapshot. */
  timeline: DeliveryTimelineView;
  /** `null` when no collection has been recorded for this job (or it is not a COD job). */
  cod: DeliveryOperationsCodView | null;
}

/**
 * Module 08's exported contract for **read-only delivery operations**, consumed in-process by
 * Module 16 (module-16 Work 36). Lists and reads delivery jobs with explicit fields.
 *
 * Deliberately absent: pickup and drop-off addresses and coordinates, the item manifest, status
 * history reasons and positions, location snapshots, proof of delivery, offers, earnings, and
 * anything about the driver beyond the profile id. It writes nothing.
 */
export interface IDeliveryOperationsReadPort {
  listJobs(filter: DeliveryOperationsFilter, page: number, size: number): Promise<DeliveryOperationsPage>;

  /** `null` when no delivery job has this id. */
  getJob(deliveryJobId: string): Promise<DeliveryOperationsDetail | null>;
}
