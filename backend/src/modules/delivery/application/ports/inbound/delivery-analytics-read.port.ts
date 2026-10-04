import { DeliveryJobStatus, DriverAvailability } from '../../../domain/enums';

export const DELIVERY_ANALYTICS_READ_PORT = Symbol('DELIVERY_ANALYTICS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export { DeliveryJobStatus, DriverAvailability } from '../../../domain/enums';

export interface DeliveryJobStatusCount {
  status: DeliveryJobStatus;
  count: number;
}

export interface DriverAvailabilityCount {
  availability: DriverAvailability;
  count: number;
}

/**
 * Delivery jobs by their current lifecycle status, and driver profiles by their declared
 * availability. Every row counts (neither table has a soft delete). Both breakdowns carry every
 * enum value in declaration order, zero-filled, so each `total` is Σ its breakdown.
 *
 * `drivers.dispatchable` is `IDriverProfileRepository.findDispatchCandidates`'s own predicate as
 * a count — `availability = ONLINE AND shiftStartedAt IS NOT NULL` — because "online" alone is
 * not "can be offered a job": a driver who has not started a shift is online in name only (§3.1
 * F-DRV-02). Nothing about any one driver — no name, no location, no earnings — crosses here.
 */
export interface DeliveryAnalyticsView {
  jobs: {
    total: number;
    byStatus: DeliveryJobStatusCount[];
  };
  drivers: {
    total: number;
    dispatchable: number;
    byAvailability: DriverAvailabilityCount[];
  };
}

/**
 * Module 08's exported contract for **read-only delivery analytics**, consumed in-process by
 * Module 16 (module-16 Work 08). Counts only. COD cash is not here — it stays on
 * `ICodFinanceReadPort`, the port that already reports it, so that a consumer holding this one
 * has not been handed money figures with it.
 */
export interface IDeliveryAnalyticsReadPort {
  summarizeDelivery(): Promise<DeliveryAnalyticsView>;
}
