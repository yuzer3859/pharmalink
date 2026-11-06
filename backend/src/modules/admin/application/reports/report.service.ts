import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../../../../shared/audit/audit.service';
import { AUDIT_READ_PORT, IAuditReadPort } from '../../../../shared/audit/audit-read.port';
import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import {
  documentRef,
  DOCUMENT_STORAGE_PORT,
  IDocumentStoragePort,
  parseDocumentRef,
  PREVIEW_URL_TTL_SECONDS,
} from '../../../../shared/storage/document-storage.port';
import {
  ORDER_OPERATIONS_READ_PORT,
  IOrderOperationsReadPort,
} from '../../../orders/application/ports/inbound/order-operations-read.port';
import {
  FINANCE_OVERSIGHT_PORT,
  IFinanceOversightPort,
} from '../../../payment/application/ports/inbound/finance-oversight.port';
import { AdminErrors } from '../../domain/errors';
import { ANALYTICS_SNAPSHOT_REPOSITORY, IAnalyticsSnapshotRepository } from '../ports/analytics-snapshot.repository.port';
import { IReportJobRepository, REPORT_JOB_REPOSITORY, ReportJobRow } from '../ports/report-job.repository.port';
import {
  buildCsv,
  BuiltCsv,
  Cell,
  MAX_REPORT_RANGE_DAYS,
  PageReader,
  REPORT_COLUMNS,
  REPORT_PAGE_SIZE,
  REPORT_TYPE_PERMISSION,
  ReportType,
} from './report-builders';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a finished report can be downloaded. */
export const REPORT_RETENTION_DAYS = 7;
/** A RUNNING job older than this is assumed abandoned (the worker died) and is queued again. */
export const STALE_RUNNING_MS = 15 * 60 * 1000;
/** Attempts before a job that keeps failing is marked FAILED. */
export const MAX_REPORT_ATTEMPTS = 3;
export const GENERATE_REPORT_PERMISSION = 'report:generate:any';

export interface Requester {
  userId: string;
  permissions: string[];
  ip?: string | null;
}

export interface ReportRange {
  /** Inclusive, `YYYY-MM-DD` (UTC). */
  from: string;
  /** Inclusive, `YYYY-MM-DD` (UTC). */
  to: string;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function parseRange(range: ReportRange): { from: Date; toExclusive: Date } {
  const parse = (value: string, field: string) => {
    const d = new Date(`${value}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime()) || isoDay(d) !== value) {
      throw AdminErrors.validation(`\`${field}\` must be a real date (YYYY-MM-DD).`);
    }
    return d;
  };
  const from = parse(range.from, 'from');
  const to = parse(range.to, 'to');
  if (from > to) throw AdminErrors.validation('`from` must not be after `to`.');
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_REPORT_RANGE_DAYS) {
    throw AdminErrors.validation(`A report covers at most ${MAX_REPORT_RANGE_DAYS} days.`);
  }
  return { from, toExclusive: new Date(to.getTime() + DAY_MS) };
}

function assertMayRun(requester: Requester, type: ReportType): void {
  if (!hasPermission(requester.permissions, GENERATE_REPORT_PERMISSION) || !hasPermission(requester.permissions, REPORT_TYPE_PERMISSION[type])) {
    throw new ApiException(ErrorCode.FORBIDDEN, `This report needs ${REPORT_TYPE_PERMISSION[type]}.`);
  }
}

/**
 * Reports (Work 90, module-16 §9.5 `/admin/finance/reports`, F-AD-23/24; backend/docs/reports.md).
 *
 * A request is queued and answered at once; `ReportWorkerJob` builds the CSV in the background,
 * page by page through each owner's read port, and stores it in document storage. The requester
 * downloads it through a short-lived signed link. Admin keeps the job row, never the file.
 */
@Injectable()
export class ReportService {
  constructor(
    @Inject(REPORT_JOB_REPOSITORY) private readonly jobs: IReportJobRepository,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: IDocumentStoragePort,
    @Inject(FINANCE_OVERSIGHT_PORT) private readonly finance: IFinanceOversightPort,
    @Inject(ORDER_OPERATIONS_READ_PORT) private readonly orders: IOrderOperationsReadPort,
    @Inject(AUDIT_READ_PORT) private readonly auditRead: IAuditReadPort,
    @Inject(ANALYTICS_SNAPSHOT_REPOSITORY) private readonly snapshots: IAnalyticsSnapshotRepository,
    private readonly audit: AuditService,
  ) {}

  /** Queues a report. The same idempotency key from the same requester returns the first job. */
  async request(input: { type: ReportType; range: ReportRange; idempotencyKey: string }, requester: Requester): Promise<{ job: ReportJobRow; created: boolean }> {
    assertMayRun(requester, input.type);
    parseRange(input.range);
    if (!this.storage.available) throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Report storage is not available.');
    const params = { from: input.range.from, to: input.range.to };
    const existing = await this.jobs.findByKey(requester.userId, input.idempotencyKey);
    if (existing) return this.replay(existing, input.type, params);
    const created = await this.jobs.create({ type: input.type, params, requestedByUserId: requester.userId, idempotencyKey: input.idempotencyKey });
    if (!created) {
      const raced = await this.jobs.findByKey(requester.userId, input.idempotencyKey);
      if (!raced) throw new Error('Report job vanished after an idempotency conflict.');
      return this.replay(raced, input.type, params);
    }
    await this.audit.record({
      actorUserId: requester.userId,
      action: 'REPORT_REQUESTED',
      resourceType: 'ReportJob',
      resourceId: created.id,
      context: { type: input.type, ...params },
      ip: requester.ip ?? null,
    });
    return { job: created, created: true };
  }

  private replay(job: ReportJobRow, type: ReportType, params: ReportRange) {
    // Field by field: JSONB does not keep key order, so a serialised comparison would refuse a true replay.
    const stored = job.params as unknown as ReportRange;
    const same = job.type === type && stored.from === params.from && stored.to === params.to;
    if (!same) throw new ApiException(ErrorCode.IDEMPOTENCY_CONFLICT, 'This Idempotency-Key was used for a different report.');
    return { job, created: false };
  }

  list(requesterId: string, page: number, size: number) {
    return this.jobs.listFor(requesterId, page, size);
  }

  /** One of the requester's own jobs; anyone else's reads as not found. */
  async get(id: string, requesterId: string): Promise<ReportJobRow> {
    const job = await this.jobs.findById(id);
    if (!job || job.requestedByUserId !== requesterId) throw ApiException.notFound('Report not found');
    return job;
  }

  /** A five-minute signed link to a finished report; audited. The requester's own, still allowed. */
  async downloadLink(id: string, requester: Requester, now = new Date()): Promise<{ url: string; expiresAt: Date; fileName: string }> {
    const job = await this.get(id, requester.userId);
    assertMayRun(requester, job.type);
    if (job.status !== 'SUCCEEDED' || !job.storageRef) throw new ApiException(ErrorCode.CONFLICT, 'The report is not ready.', { status: job.status });
    if (job.expiresAt && job.expiresAt <= now) throw new ApiException(ErrorCode.CONFLICT, 'The report has expired; request it again.', { status: 'EXPIRED' });
    const ref = parseDocumentRef(job.storageRef);
    if (!ref || !this.storage.available) throw new ApiException(ErrorCode.DEPENDENCY_UNAVAILABLE, 'Report storage is not available.');
    const link = await this.storage.signRead(ref, 'text/csv', PREVIEW_URL_TTL_SECONDS);
    await this.audit.record({
      actorUserId: requester.userId,
      action: 'REPORT_DOWNLOADED',
      resourceType: 'ReportJob',
      resourceId: job.id,
      context: { type: job.type, rowCount: job.rowCount },
      ip: requester.ip ?? null,
    });
    return { url: link.url, expiresAt: link.expiresAt, fileName: fileName(job) };
  }

  /** Builds the oldest queued report, if any. Returns the job's id, or `null` when idle. */
  async runNext(now = new Date()): Promise<string | null> {
    await this.jobs.requeueStale(new Date(now.getTime() - STALE_RUNNING_MS));
    const job = await this.jobs.claimNext(now);
    if (!job) return null;
    try {
      const params = job.params as unknown as ReportRange;
      // Nothing written after the build started is included, so pages read newest-first stay stable.
      const range = parseRange(params);
      const asOf = job.startedAt ?? now;
      const built = await this.build(job.type, { from: range.from, toExclusive: range.toExclusive < asOf ? range.toExclusive : asOf });
      const ref = documentRef('reports', job.requestedByUserId, randomUUID());
      await this.storage.put(parseDocumentRef(ref)!, 'text/csv', built.content);
      await this.jobs.succeed(job.id, {
        rowCount: built.rowCount,
        bytes: built.content.length,
        truncated: built.truncated,
        storageRef: ref,
        finishedAt: new Date(),
        expiresAt: new Date(Date.now() + REPORT_RETENTION_DAYS * DAY_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= MAX_REPORT_ATTEMPTS) await this.jobs.fail(job.id, message, new Date());
      else await this.jobs.requeue(job.id);
    }
    return job.id;
  }

  private build(type: ReportType, range: { from: Date; toExclusive: Date }): Promise<BuiltCsv> {
    return buildCsv(REPORT_COLUMNS[type], this.reader(type, range));
  }

  private reader(type: ReportType, { from, toExclusive }: { from: Date; toExclusive: Date }): PageReader {
    const size = REPORT_PAGE_SIZE;
    const more = (page: number, total: number) => page * size < total;
    switch (type) {
      case 'PAYMENTS':
        return async (page) => {
          const r = await this.finance.listPayments({ createdFrom: from, createdTo: toExclusive }, page, size);
          return {
            more: more(page, r.total),
            rows: r.items.map((p): Cell[] => [p.paymentId, p.orderId, p.customerUserId, p.amount, p.currency, p.method, p.status, p.provider, p.providerRef, p.authorizedAt, p.capturedAt, p.failureReason, p.createdAt]),
          };
        };
      case 'REFUNDS':
        return async (page) => {
          const r = await this.finance.listRefunds({ createdFrom: from, createdTo: toExclusive }, page, size);
          return {
            more: more(page, r.total),
            rows: r.items.map((x): Cell[] => [x.refundId, x.paymentId, x.amount, x.currency, x.type, x.destination, x.status, x.providerRef, x.reason, x.approvedBy, x.createdAt, x.completedAt]),
          };
        };
      case 'ORDERS':
        return async (page) => {
          const r = await this.orders.listOrders({ createdFrom: from, createdTo: toExclusive }, page, size);
          return {
            more: more(page, r.total),
            rows: r.items.map((o): Cell[] => [o.orderId, o.orderNumber, o.status, o.isCod, o.grandTotal, o.currency, o.lineCount, o.fulfillmentCount, o.placedAt, o.createdAt]),
          };
        };
      case 'AUDIT':
        return async (page) => {
          const r = await this.auditRead.search({ from, to: toExclusive }, page, size);
          return {
            more: more(page, r.total),
            rows: r.items.map((a): Cell[] => [a.id, a.createdAt, a.actorUserId, a.action, a.resourceType, a.resourceId, a.ip, a.hash]),
          };
        };
      case 'ANALYTICS_DAILY':
        return async () => {
          const keys = await this.snapshots.listMetricKeys();
          const rows = await this.snapshots.findRange(keys, from, new Date(toExclusive.getTime() - 1));
          return {
            more: false,
            rows: rows
              .sort((a, b) => +a.windowStart - +b.windowStart || a.metricKey.localeCompare(b.metricKey))
              .map((r): Cell[] => [isoDay(r.windowStart), r.metricKey, r.value]),
          };
        };
    }
  }
}

export const fileName = (job: Pick<ReportJobRow, 'type' | 'params'>) => {
  const p = job.params as unknown as ReportRange;
  return `pharmalink-${job.type.toLowerCase().replace(/_/g, '-')}-${p.from}-to-${p.to}.csv`;
};
