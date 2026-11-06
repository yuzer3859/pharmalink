import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { AuthenticatedPrincipal } from '../../../../shared/rbac/rbac.types';
import { CurrentUser } from '../../../identity/interface/decorators/current-user.decorator';
import { ActivityReport, AdminActivityService } from '../../application/activity/admin-activity.service';
import { AdminActivityEntriesQueryDto, AdminActivityQueryDto } from '../dtos/admin-activity.dto';
import { toAuditListResponse } from '../dtos/audit.response';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toReportResponse(r: ActivityReport) {
  return {
    from: r.from.toISOString(),
    to: r.to.toISOString(),
    truncated: r.truncated,
    staff: r.staff.map((s) => ({
      userId: s.userId,
      email: s.email,
      phone: s.phone,
      status: s.status,
      roles: s.roles,
      total: s.total,
      byAction: s.byAction,
      firstAt: iso(s.firstAt),
      lastAt: iso(s.lastAt),
      distinctIps: s.distinctIps,
      flags: s.flags.map((f) => ({ rule: f.rule, count: f.count, firstAt: f.firstAt.toISOString(), exampleIds: f.exampleIds })),
    })),
  };
}

/**
 * Admin activity and anomaly monitoring (Work 88, module-16 §9.7, F-AD-27;
 * backend/docs/admin-activity.md).
 *
 *     GET /admin/admins/activity            per staff member: counts, roles, flags
 *     GET /admin/admins/activity/{userId}   that member's audit entries, newest first
 *
 * `staff:monitor:any` — SUPER_ADMIN only (by wildcard): the view watches administrators.
 * Read-only over Module 01's staff list and the shared audit trail; each read is audited.
 */
@Controller('admin/admins/activity')
@RequirePermissions('staff:monitor:any')
export class AdminActivityController {
  constructor(private readonly activity: AdminActivityService) {}

  @Get()
  async report(@CurrentUser() user: AuthenticatedPrincipal, @Query() q: AdminActivityQueryDto, @Req() req: Request) {
    return toReportResponse(await this.activity.report({ from: q.from, to: q.to }, { userId: user.userId, ip: req.ip ?? null }));
  }

  @Get(':userId')
  async entries(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query() q: AdminActivityEntriesQueryDto,
    @Req() req: Request,
  ) {
    return toAuditListResponse(
      await this.activity.entriesOf(userId, { from: q.from, to: q.to, page: q.page ?? 1, size: q.size ?? 25 }, { userId: user.userId, ip: req.ip ?? null }),
    );
  }
}
