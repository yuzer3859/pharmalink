import { DeliveryJobStatus, DriverAvailability } from '../../../domain/enums';

export const DRIVER_OPERATIONS_READ_PORT = Symbol('DRIVER_OPERATIONS_READ_PORT');

/** Re-exported so a consumer depends on this one file and not on Module 08's domain layer. */
export { DeliveryJobStatus, DriverAvailability } from '../../../domain/enums';

/** Every filter is a column of `driver_profiles`. */
export interface DriverOperationsFilter {
  availability?: DriverAvailability;
  /** `shiftStartedAt IS NOT NULL` (`true`) or `IS NULL` (`false`) — the schema's own definition of on shift. */
  onShift?: boolean;
}

export interface DriverJobStatusCount {
  status: DeliveryJobStatus;
  count: number;
}

/**
 * One driver profile's operational state and workload, as Module 08 defines them.
 *
 * - `availability` is the stored `DriverAvailability` — the driver's own ONLINE/OFFLINE toggle, or
 *   BUSY as dispatch sets it. It is never inferred from jobs.
 * - `onShift` is `shiftStartedAt !== null`, the schema's definition (§3.1 F-DRV-02).
 * - `jobsByStatus` counts `delivery_jobs` rows whose `assignedDriverId` is this profile **now**,
 *   every `DeliveryJobStatus` value in declaration order, zero-filled; `totalJobs` is Σ of it. A job
 *   released to `REASSIGNING` has its driver cleared (`DeliveryJob`'s own rule), so it — and
 *   whatever it becomes — is attributed to whoever holds it next, not to this profile.
 * - `activeJobCount` is the count over `DriverAvailabilityPolicy.ACTIVE_JOB_STATUSES` — exactly the
 *   BRULE-28 concurrent-slot count `IDeliveryJobRepository.countActiveJobs` takes.
 *
 * Nothing about the person: no Module 01 user id, vehicle plate, service area or position.
 */
export interface DriverOperationsSummary {
  driverProfileId: string;
  availability: DriverAvailability;
  onShift: boolean;
  shiftStartedAt: Date | null;
  lastOnlineAt: Date | null;
  /** When the last position was received — the time only, never the coordinates. */
  lastLocationAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  totalJobs: number;
  activeJobCount: number;
  jobsByStatus: DriverJobStatusCount[];
}

export interface DriverOperationsPage {
  items: DriverOperationsSummary[];
  total: number;
  page: number;
  size: number;
}

/**
 * Module 08's exported contract for **read-only driver operations**, consumed in-process by Module
 * 16 (module-16 Work 37). Status semantics, the driver/job relationship and every count stay here.
 * It writes nothing.
 */
export interface IDriverOperationsReadPort {
  listDrivers(filter: DriverOperationsFilter, page: number, size: number): Promise<DriverOperationsPage>;

  /** `null` when no driver profile has this id. */
  getDriver(driverProfileId: string): Promise<DriverOperationsSummary | null>;
}
