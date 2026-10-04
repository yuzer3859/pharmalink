import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetAuditEntryQuery } from '../../application/queries/get-audit-entry.query';
import { ListAuditQuery } from '../../application/queries/list-audit.query';
import { ListAuditQueryDto } from '../dtos/audit.dto';
import {
  AuditEntryDetailResponse,
  AuditListResponse,
  toAuditEntryDetailResponse,
  toAuditListResponse,
} from '../dtos/audit.response';

/**
 * Audit explorer (module-16 §9.7, §11.5, FR-ADM-12, BRULE-48) — **read-only**.
 *
 *     GET /admin/audit        the trail, newest first, filterable by column
 *     GET /admin/audit/{id}   one entry, with its own-link integrity
 *
 * There is no other verb. Nothing here can append, edit, delete or reorder an entry, and the
 * chain's hashes are returned exactly as stored — the read port this controller uses has two
 * `SELECT`s and no other statement.
 *
 * ## Authorization
 *
 * `audit:read:any` — an existing catalogue key, held by `ADMIN` and `SUPER_ADMIN`. The design
 * says "Super Admin (Admin: scoped)"; the catalogue as seeded grants `ADMIN` the unscoped key,
 * and that grant is applied as found rather than narrowed here.
 *
 * ## What reading does not do
 *
 * It writes nothing. The repository has no sensitive-read audit convention, and a `*_VIEWED`
 * entry per investigation would put the investigator into the trail being investigated — a
 * policy decision for the audit design, not a default to assume.
 *
 * ## No action catalogue endpoint
 *
 * Action names are string literals at each writer (`CONFIG_CHANGED`,
 * `identity.verification.approved`, …) with no shared enum to enumerate; a `GET /admin/audit/
 * actions` would have to be invented from a `SELECT DISTINCT`, and the brief says not to.
 *
 * Errors: a malformed id is `400` (`ParseUUIDPipe`, mapped to `VALIDATION_ERROR`), an unknown
 * one `404`, an unentitled caller `403`, no token `401`.
 */
@Controller('admin/audit')
export class AdminAuditController {
  constructor(
    private readonly list: ListAuditQuery,
    private readonly getOne: GetAuditEntryQuery,
  ) {}

  @Get()
  @RequirePermissions('audit:read:any')
  async search(@Query() query: ListAuditQueryDto): Promise<AuditListResponse> {
    return toAuditListResponse(
      await this.list.execute({
        action: query.action,
        actorUserId: query.actorUserId,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        page: query.page,
        size: query.size,
      }),
    );
  }

  @Get(':id')
  @RequirePermissions('audit:read:any')
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<AuditEntryDetailResponse> {
    return toAuditEntryDetailResponse(await this.getOne.execute(id));
  }
}
