import { authService, type SessionRequest } from './auth.service';
import { toQuery } from './adminFinance.service';
import { newIdempotencyKey } from './settlementPayout.service';

export type ReportType = 'PAYMENTS' | 'REFUNDS' | 'ORDERS' | 'AUDIT' | 'ANALYTICS_DAILY';
export type ReportStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';

export interface ReportJob {
  id: string;
  type: ReportType;
  from: string;
  to: string;
  status: ReportStatus;
  rowCount: number | null;
  bytes: number | null;
  truncated: boolean;
  error: string | null;
  fileName: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
}

export const REPORT_LABELS: Record<ReportType, { label: string; help: string }> = {
  PAYMENTS: { label: 'Payments', help: 'Every payment created in the period, amounts in santim.' },
  REFUNDS: { label: 'Refunds', help: 'Every refund created in the period, amounts in santim.' },
  ORDERS: { label: 'Orders', help: 'Every order created in the period, totals in santim.' },
  AUDIT: { label: 'Audit trail', help: 'Every audit entry in the period, with its hash; no free-form context.' },
  ANALYTICS_DAILY: { label: 'Daily analytics', help: 'Every daily snapshot figure in the period.' },
};

/** The server's limit on one report's window, in days. */
export const MAX_REPORT_DAYS = 366;

/** Why a range cannot be requested, or `null`. Mirrors the server's checks. */
export function rangeProblem(from: string, to: string): string | null {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(from) || !day.test(to)) return 'Choose both dates.';
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 'Choose real dates.';
  if (a > b) return 'The start must not be after the end.';
  if ((b - a) / 86_400_000 + 1 > MAX_REPORT_DAYS) return `A report covers at most ${MAX_REPORT_DAYS} days.`;
  return null;
}

/** Still being built: the page polls while any report is. */
export const isPending = (job: Pick<ReportJob, 'status'>) => job.status === 'QUEUED' || job.status === 'RUNNING';

export function createAdminReportsService(request: SessionRequest, idempotencyKey: () => string = newIdempotencyKey) {
  return {
    types(): Promise<{ types: Array<{ type: ReportType; permission: string; allowed: boolean }> }> {
      return request('/admin/reports/types', { method: 'GET' });
    },
    list(page = 1, size = 25): Promise<{ items: ReportJob[]; total: number; page: number; size: number }> {
      return request(`/admin/reports${toQuery({ page, size })}`, { method: 'GET' });
    },
    /** Queues a report; the server builds it in the background. */
    request(input: { type: ReportType; from: string; to: string }): Promise<ReportJob> {
      return request('/admin/reports', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: input });
    },
    /** A five-minute signed link to the CSV; the server audits each one. */
    download(id: string): Promise<{ url: string; expiresAt: string; fileName: string }> {
      return request(`/admin/reports/${encodeURIComponent(id)}/download`, { method: 'POST', body: {} });
    },
  };
}

export const adminReportsService = createAdminReportsService(authService.request);
