import { DeliveryBacklogSummary } from '../../../delivery/application/ports/inbound/delivery-backlog-summary-read.port';

/** Aggregate counts and timestamps only — no job, order, driver or location identifier. */
export interface DeliveryBacklogSummaryResponse {
  generatedAt: string;
  jobs: {
    total: number;
    byStatus: Record<string, number>;
    nonTerminalCount: number;
    oldestNonTerminalCreatedAt: string | null;
    oldestNonTerminalAgeSeconds: number | null;
  };
  assignment: {
    unassignedCount: number;
  };
}

// Explicit allow-list, never a spread of the port object.
export function toDeliveryBacklogSummaryResponse(s: DeliveryBacklogSummary): DeliveryBacklogSummaryResponse {
  const j = s.jobs;
  return {
    generatedAt: s.generatedAt.toISOString(),
    jobs: {
      total: j.total,
      byStatus: Object.fromEntries(Object.entries(j.byStatus).map(([status, n]) => [status, n])),
      nonTerminalCount: j.nonTerminalCount,
      oldestNonTerminalCreatedAt: j.oldestNonTerminalCreatedAt ? j.oldestNonTerminalCreatedAt.toISOString() : null,
      oldestNonTerminalAgeSeconds: j.oldestNonTerminalAgeSeconds,
    },
    assignment: { unassignedCount: s.assignment.unassignedCount },
  };
}
