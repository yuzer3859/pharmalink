import { ReportJob, ReportStatus, ReportType } from '@prisma/client';

export const REPORT_JOB_REPOSITORY = Symbol('REPORT_JOB_REPOSITORY');

export type ReportJobRow = ReportJob;
export { ReportStatus, ReportType };

/** `report_jobs` (Work 90), Admin's own table. */
export interface IReportJobRepository {
  /** `null` when this requester already used the idempotency key (the existing job is returned by `findByKey`). */
  create(data: { type: ReportType; params: Record<string, unknown>; requestedByUserId: string; idempotencyKey: string }): Promise<ReportJobRow | null>;
  findByKey(requestedByUserId: string, idempotencyKey: string): Promise<ReportJobRow | null>;
  findById(id: string): Promise<ReportJobRow | null>;
  listFor(requestedByUserId: string, page: number, size: number): Promise<{ items: ReportJobRow[]; total: number }>;
  /** Atomically moves the oldest QUEUED job to RUNNING and returns it; `null` when none is queued. */
  claimNext(now: Date): Promise<ReportJobRow | null>;
  /** RUNNING jobs started before `before` go back to QUEUED (a worker died mid-build). */
  requeueStale(before: Date): Promise<number>;
  /** This one RUNNING job back to QUEUED (its build failed and it has attempts left). */
  requeue(id: string): Promise<void>;
  succeed(id: string, data: { rowCount: number; bytes: number; truncated: boolean; storageRef: string; finishedAt: Date; expiresAt: Date }): Promise<void>;
  fail(id: string, error: string, finishedAt: Date): Promise<void>;
}
