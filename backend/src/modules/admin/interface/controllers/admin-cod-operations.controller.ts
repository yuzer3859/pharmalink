import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { RequirePermissions } from '../../../../shared/rbac/permissions.decorator';
import { GetCodOperationsQuery, ListCodOperationsQuery } from '../../application/queries/cod-operations.queries';
import { ListCodOperationsQueryDto } from '../dtos/cod-operations.dto';
import {
  CodOperationsDetailResponse,
  CodOperationsListResponse,
  toCodOperationsDetailResponse,
  toCodOperationsListResponse,
} from '../dtos/cod-operations.response';

/**
 * COD operations visibility (module-16 Work 38) — read-only:
 *
 *     GET /admin/operations/cod                 ?status &orderId &jobId &collectedFrom &collectedTo &page &size
 *     GET /admin/operations/cod/:collectionId   one collection, its remittance, reconciliation, corrections, disputes
 *
 * `finance:report:any` — the existing read-only finance permission that already guards Work 06's
 * dispute reads, Work 07's finance oversight and Module 08's own COD reconciliation reads (ADMIN,
 * FINANCE_OFFICER; SUPER_ADMIN by wildcard). No note, reason, reference, provider detail or user id is
 * returned. Not audited.
 */
@Controller('admin/operations/cod')
@RequirePermissions('finance:report:any')
export class AdminCodOperationsController {
  constructor(
    private readonly list: ListCodOperationsQuery,
    private readonly getOne: GetCodOperationsQuery,
  ) {}

  @Get()
  async search(@Query() q: ListCodOperationsQueryDto): Promise<CodOperationsListResponse> {
    return toCodOperationsListResponse(
      await this.list.execute({
        status: q.status,
        orderId: q.orderId,
        jobId: q.jobId,
        collectedFrom: q.collectedFrom ? new Date(q.collectedFrom) : undefined,
        collectedTo: q.collectedTo ? new Date(q.collectedTo) : undefined,
        page: q.page,
        size: q.size,
      }),
    );
  }

  @Get(':collectionId')
  async detail(@Param('collectionId', new ParseUUIDPipe()) collectionId: string): Promise<CodOperationsDetailResponse> {
    return toCodOperationsDetailResponse(await this.getOne.execute(collectionId));
  }
}
