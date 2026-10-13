import {
  DriverOperationsPage,
  DriverOperationsSummary,
} from '../../../delivery/application/ports/inbound/driver-operations-read.port';

/** One driver profile's operational state — Module 08's values, nothing about the person. */
export interface DriverOperationsResponse {
  driverProfileId: string;
  availability: string;
  onShift: boolean;
  shiftStartedAt: string | null;
  lastOnlineAt: string | null;
  lastLocationAt: string | null;
  createdAt: string;
  updatedAt: string;
  totalJobs: number;
  activeJobCount: number;
  jobsByStatus: Array<{ status: string; count: number }>;
}

export interface DriverOperationsListResponse {
  items: DriverOperationsResponse[];
  total: number;
  page: number;
  size: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// Explicit allow-lists, never spreads of port objects.
export function toDriverOperationsResponse(d: DriverOperationsSummary): DriverOperationsResponse {
  return {
    driverProfileId: d.driverProfileId,
    availability: d.availability,
    onShift: d.onShift,
    shiftStartedAt: iso(d.shiftStartedAt),
    lastOnlineAt: iso(d.lastOnlineAt),
    lastLocationAt: iso(d.lastLocationAt),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    totalJobs: d.totalJobs,
    activeJobCount: d.activeJobCount,
    jobsByStatus: d.jobsByStatus.map((b) => ({ status: b.status, count: b.count })),
  };
}

export function toDriverOperationsListResponse(p: DriverOperationsPage): DriverOperationsListResponse {
  return { items: p.items.map(toDriverOperationsResponse), total: p.total, page: p.page, size: p.size };
}
