import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { hasPermission } from '../../../../shared/rbac/permission-matcher';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ReportJobRow } from '../../application/ports/report-job.repository.port';
import { REPORT_TYPE_PERMISSION, ReportType } from '../../application/reports/report-builders';
import { fileName, GENERATE_REPORT_PERMISSION, Requester, ReportService } from '../../application/reports/report.service';
import { RequireIdempotencyKey } from '../decorators/idempotency-key.decorator';
import { ListReportsQueryDto, RequestReportDto } from '../dtos/report.dto';

const requester = (user: AuthenticatedPrincipal, req: Request): Requester => ({
  userId: user.userId,
  permissions: user.permissions ?? [],
  ip: req.ip ?? null,
});

/** What the portal shows. Never the storage reference, and no error internals. */
export function toReportResponse(job: ReportJobRow, now = new Date()) {
  const expired = job.status === 'SUCCEEDED' && !!job.expiresAt && job.expiresAt <= now;
  const params = job.params as { from: string; to: string };
  return {
    id: job.id,
    type: job.type,
    from: params.from,
    to: params.to,
    status: expired ? 'EXPIRED' : job.status,
    rowCount: job.rowCount,
    bytes: job.bytes,
    truncated: job.truncated,
    error: job.status === 'FAILED' ? 'The report could not be built.' : null,
    fileName: fileName(job),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
  };
}

/**
 * Reports (Work 90, module-16 §9.5, F-AD-23/24; backend/docs/reports.md).
 *
 *     GET  /admin/reports/types           the report types and whether the caller may run each
 *     POST /admin/reports                 queue one (Idempotency-Key) → 202, a replay → 200
 *     GET  /admin/reports                 the caller's own reports, newest first
 *     GET  /admin/reports/{id}            one of them
 *     POST /admin/reports/{id}/download   a five-minute signed link to the CSV, audited
 *
 * `report:generate:any` (ADMIN, FINANCE_OFFICER) plus, per type, that data's read authority:
 * payments and refunds `finance:report:any`, orders `order:read:any`, audit `audit:read:any`,
 * analytics `analytics:read`. Both are checked when a report is requested and again on download.
 */
@Controller('admin/reports')
@RequirePermissions(GENERATE_REPORT_PERMISSION)
export class AdminReportsController {
  constructor(private readonly reports: ReportService) {}

  @Get('types')
  types(@CurrentUser() user: AuthenticatedPrincipal) {
    const grants = user.permissions ?? [];
    return {
      types: (Object.keys(REPORT_TYPE_PERMISSION) as ReportType[]).map((type) => ({
        type,
        permission: REPORT_TYPE_PERMISSION[type],
        allowed: hasPermission(grants, REPORT_TYPE_PERMISSION[type]),
      })),
    };
  }

  @Post()
  async request(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: RequestReportDto,
    @RequireIdempotencyKey() idempotencyKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { job, created } = await this.reports.request(
      { type: body.type, range: { from: body.from, to: body.to }, idempotencyKey },
      requester(user, req),
    );
    res.status(created ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return toReportResponse(job);
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedPrincipal, @Query() q: ListReportsQueryDto) {
    const page = q.page ?? 1;
    const size = q.size ?? 25;
    const result = await this.reports.list(user.userId, page, size);
    return { items: result.items.map((j) => toReportResponse(j)), total: result.total, page, size };
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return toReportResponse(await this.reports.get(id, user.userId));
  }

  @Post(':id/download')
  @HttpCode(HttpStatus.OK)
  async download(@CurrentUser() user: AuthenticatedPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    const link = await this.reports.downloadLink(id, requester(user, req));
    return { url: link.url, expiresAt: link.expiresAt.toISOString(), fileName: link.fileName };
  }
}
